/**
 * Main.js
 * Webhook router, command dispatcher, and setup utilities.
 */

/**
 * Handles incoming POST requests from Telegram Webhook.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput("OK");
    }

    var update;
    try {
      update = JSON.parse(e.postData.contents);
    } catch (err) {
      console.error("Invalid JSON payload received: " + e.postData.contents);
      return HtmlService.createHtmlOutput("OK");
    }

    // --- DEDUPLICATION GUARD ---
    // Telegram will retry webhook delivery if there is network latency or cold-start delay.
    // We cache each update_id for 10 minutes. If Telegram retries, we return OK immediately.
    if (update.update_id) {
      var cache = CacheService.getScriptCache();
      var updateKey = 'tg_upd_' + update.update_id;
      if (cache.get(updateKey)) {
        console.warn("Ignored duplicate update_id: " + update.update_id);
        return HtmlService.createHtmlOutput("OK");
      }
      cache.put(updateKey, '1', 600); // 10 minutes TTL
    }

    // 1. Handle Inline Keyboard Button Clicks
    if (update.callback_query) {
      AdminHandler.handleCallback(update.callback_query);
      return HtmlService.createHtmlOutput("OK");
    }

    // 2. Handle Messages
    if (update.message) {
      handleIncomingMessage(update.message);
      return HtmlService.createHtmlOutput("OK");
    }

  } catch (globalErr) {
    console.error("Unhandled error in doPost: " + (globalErr.stack || globalErr.message));
  }

  return HtmlService.createHtmlOutput("OK");
}

/**
 * Handles incoming text messages and photo submissions.
 * @param {Object} message
 */
function handleIncomingMessage(message) {
  var chatId = message.chat.id;
  var fromUser = message.from || {};
  var text = message.text || message.caption || '';
  var adminChatId = '';
  try {
    adminChatId = Config.getAdminChatId();
  } catch (e) {}

  var isAdmin = String(chatId) === String(adminChatId);

  // --- 1. Admin Text Interaction or Commands in Admin DM ---
  if (isAdmin && text) {
    // Check if admin is currently answering an interactive prompt (e.g. entering custom number or retake reason)
    var handledByState = AdminHandler.handleAdminText(chatId, text);
    if (handledByState) {
      return;
    }

    // Handle Admin Slash Commands
    if (text.indexOf('/start') === 0 || text.indexOf('/help') === 0) {
      sendAdminHelp(chatId);
      return;
    }

    if (text.indexOf('/status') === 0) {
      sendAdminStatus(chatId);
      return;
    }

    if (text.indexOf('/remind') === 0) {
      Telegram.sendMessage(chatId, "⏳ Запуск щомісячного нагадування...");
      ReminderService.sendMonthlyReminders();
      return;
    }
  }

  // --- 2. General Utility Command: /id or /chatid in any chat ---
  if (text && (text.indexOf('/id') === 0 || text.indexOf('/chatid') === 0)) {
    var chatInfo = "🆔 <b>Інформація про чат:</b>\n" +
      "• Chat ID: <code>" + chatId + "</code>\n" +
      "• Тип: <code>" + message.chat.type + "</code>\n" +
      "• Назва: " + Telegram.escapeHtml(message.chat.title || 'Особистий чат');
    Telegram.sendMessage(chatId, chatInfo, { reply_to_message_id: message.message_id });
    return;
  }

  // --- 3. Photo Submissions ---
  if (message.photo && message.photo.length > 0) {
    processPhotoSubmission(message);
    return;
  }
}

/**
 * Processes a photo submission from a tenant or administrator.
 * @param {Object} message
 */
function processPhotoSubmission(message) {
  var chatId = message.chat.id;
  var fromUser = message.from || {};
  var photos = message.photo;

  // Select the highest resolution photo by pixel dimensions
  var largestPhoto = photos[0];
  var maxPixels = 0;
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    var pixels = (p.width || 0) * (p.height || 0);
    if (pixels >= maxPixels) {
      maxPixels = pixels;
      largestPhoto = p;
    }
  }
  var fileId = largestPhoto.file_id;
  console.log('Selected photo for AI: ' + largestPhoto.width + 'x' + largestPhoto.height + ' (' + maxPixels + ' px)');

  // Find candidate meters for this chat
  var candidateMeters = Config.getMetersForChat(chatId);

  // Send subtle processing acknowledgement in group
  var ackMsgId = null;
  try {
    var ack = Telegram.sendMessage(
      chatId,
      "⏳ Фото отримано, розпізнаю показники через AI...",
      { reply_to_message_id: message.message_id }
    );
    if (ack.ok && ack.result) {
      ackMsgId = ack.result.message_id;
    }
  } catch (e) {}

  // Download photo blob
  var imageBlob = Telegram.getFileBlob(fileId);

  // Analyze image with Gemini
  var aiResult;
  try {
    aiResult = Gemini.analyzeMeterImage(imageBlob, candidateMeters);
  } catch (geminiErr) {
    console.error("Gemini analysis error: " + geminiErr.message);
    aiResult = {
      recognized: false,
      meter_id: null,
      meter_type: "unknown",
      meter_code: null,
      reading_value: null,
      confidence_score: 0.0,
      issue_notes: "Помилка виклику AI: " + geminiErr.message
    };
  }

  // Auto-resolve meter_id if AI did not find a direct serial match:
  // 1. If chat has only 1 meter, auto-assign it.
  // 2. If chat has multiple meters, but only 1 matches the recognized meter_type (e.g. only 1 gas meter), auto-assign it.
  if (!aiResult.meter_id && candidateMeters && candidateMeters.length > 0) {
    if (candidateMeters.length === 1) {
      aiResult.meter_id = candidateMeters[0].meter.meter_id;
    } else if (aiResult.meter_type && aiResult.meter_type !== 'unknown') {
      var typeMatches = candidateMeters.filter(function (cm) {
        return cm.meter.type === aiResult.meter_type;
      });
      if (typeMatches.length === 1) {
        aiResult.meter_id = typeMatches[0].meter.meter_id;
        console.log('Auto-matched meter by unique type (' + aiResult.meter_type + '): ' + aiResult.meter_id);
      }
    }
  }

  // Prepare session for Admin confirmation
  var sessionData = {
    sourceChatId: chatId,
    sourceMessageId: message.message_id,
    chatTitle: message.chat.title || 'Особистий чат',
    senderId: fromUser.id,
    senderUsername: fromUser.username || '',
    senderName: [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 'Користувач',
    photoFileId: fileId,
    recognized: aiResult.recognized,
    meter_id: aiResult.meter_id,
    meter_type: aiResult.meter_type,
    meter_code: aiResult.meter_code,
    reading_value: aiResult.reading_value,
    confidence_score: aiResult.confidence_score,
    issue_notes: aiResult.issue_notes
  };

  var sessionId = StateService.saveSession(sessionData);
  sessionData.sessionId = sessionId;

  // Send confirmation card to Admin
  AdminHandler.sendConfirmationCard(sessionData);

  // Update or delete group acknowledgement
  if (ackMsgId) {
    try {
      Telegram.callApi('deleteMessage', {
        chat_id: chatId,
        message_id: ackMsgId
      });
    } catch (delErr) {
      // If delete fails, edit to simple confirmation
      Telegram.editMessageText(chatId, ackMsgId, "✅ Фото передано адміністратору на перевірку.");
    }
  }
}

/**
 * Sends Admin help menu.
 */
function sendAdminHelp(chatId) {
  var helpText = "🤖 <b>Панель керування ботом лічильників</b>\n\n" +
    "• <b>/status</b> — Перевірити статус системи та конфігурацію об'єктів\n" +
    "• <b>/remind</b> — Надіслати позачергове нагадування у всі чати\n" +
    "• <b>/chatid</b> — Дізнатися ID поточного чату\n\n" +
    "Коли мешканці надсилають фото лічильників у зареєстровані чати, ви автоматично отримуватимете сюди картки підтвердження з кнопками.";
  Telegram.sendMessage(chatId, helpText);
}

/**
 * Sends Admin status report.
 */
function sendAdminStatus(chatId) {
  var config = Config.getConfig();
  var props = config.properties || [];
  var totalMeters = 0;

  var text = "📊 <b>Статус системи обліку:</b>\n\n" +
    "• Зареєстровано об'єктів: <b>" + props.length + "</b>\n";

  props.forEach(function (p) {
    var metersCount = (p.meters && p.meters.length) || 0;
    totalMeters += metersCount;
    text += "\n🏠 <b>" + Telegram.escapeHtml(p.address_name) + "</b>\n" +
      "  - Чат: <code>" + (p.source_chat_id || 'Не вказано') + "</code>\n" +
      "  - Лічильників: " + metersCount + "\n";
  });

  text += "\n• Загалом лічильників: <b>" + totalMeters + "</b>";
  Telegram.sendMessage(chatId, text);
}

/**
 * HTTP GET endpoint for diagnostics and health check.
 */
function doGet(e) {
  var now = new Date();
  var config = Config.getConfig();
  var propsCount = (config.properties && config.properties.length) || 0;

  var info = {
    status: "online",
    time_kyiv: Utilities.formatDate(now, "Europe/Kyiv", "yyyy-MM-dd HH:mm:ss"),
    configured_properties: propsCount,
    version: "1.0.0"
  };

  return ContentService.createTextOutput(JSON.stringify(info, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Convenience helper to set the webhook from the Google Apps Script editor.
 * Drops any stuck pending retries by default.
 */
function setupWebhook() {
  var webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl) {
    throw new Error("Please set 'WEB_APP_URL' in Script Properties (File -> Project Settings -> Script Properties) with your published Web App exec URL.");
  }

  var res = Telegram.setWebhook(webAppUrl.trim(), true);
  console.log("Telegram setWebhook response: " + JSON.stringify(res));
  return res;
}

/**
 * Convenience helper to check webhook diagnostics from GAS editor.
 * Shows pending update count and any Telegram webhook delivery errors.
 */
function checkWebhookStatus() {
  var res = Telegram.getWebhookInfo();
  console.log("Current Telegram Webhook Info:\n" + JSON.stringify(res, null, 2));

  if (res.result) {
    var info = res.result;
    console.log("------------------------------------------");
    console.log("Webhook URL: " + info.url);
    console.log("Pending updates in queue: " + info.pending_update_count);
    if (info.last_error_message) {
      console.log("⚠️ Last Error Message: " + info.last_error_message);
      console.log("⚠️ Last Error Date: " + new Date(info.last_error_date * 1000).toISOString());
    } else {
      console.log("✅ No webhook errors reported by Telegram.");
    }
    console.log("------------------------------------------");
  }
  return res;
}

/**
 * Purges any stuck pending retries from Telegram's queue.
 */
function clearPendingTelegramUpdates() {
  var webAppUrl = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!webAppUrl) {
    throw new Error("Please set 'WEB_APP_URL' in Script Properties.");
  }
  var res = Telegram.setWebhook(webAppUrl.trim(), true);
  console.log("Purged pending Telegram updates: " + JSON.stringify(res));
  return res;
}

/**
 * Convenience helper to install the monthly reminder trigger.
 */
function setupMonthlyTrigger() {
  ReminderService.setupMonthlyTrigger();
}
