/**
 * AdminHandler.js
 * Handles admin confirmation cards, interactive inline callbacks, and manual overrides.
 */

var AdminHandler = (function () {

  /**
   * Builds the formatted card text in Ukrainian.
   * @param {Object} session
   * @returns {string}
   */
  function formatCardText(session) {
    var found = Config.findMeterById(session.meter_id);
    var meterName = found ? found.meter.name_uk : (session.meter_type || 'Невідомий');
    var meterCode = found ? (found.meter.code || '—') : (session.meter_code || '—');

    var text = "📥 <b>Отримано нове фото лічильника!</b>\n\n";

    // Target properties
    text += "• <b>Об’єкти:</b>\n";
    if (found) {
      text += "  - " + Telegram.escapeHtml(found.property.address_name) + " (Стовпчик " + found.meter.target_column + ")\n";
      if (found.meter.shared_targets && Array.isArray(found.meter.shared_targets)) {
        found.meter.shared_targets.forEach(function (shared) {
          var p = Config.getPropertyById(shared.property_id);
          var addr = p ? p.address_name : shared.property_id;
          text += "  - " + Telegram.escapeHtml(addr) + " (Стовпчик " + shared.target_column + ") [🔗 <i>Спільний лічильник</i>]\n";
        });
      }
    } else {
      text += "  - <i>Не закріплено за адресою (потрібно вибрати лічильник вручну)</i>\n";
    }

    var senderDisplay = session.senderUsername ? ('@' + session.senderUsername) : (session.senderName || 'Користувач');
    text += "• <b>Джерело:</b> " + Telegram.escapeHtml(session.chatTitle || ('ID: ' + session.sourceChatId)) + "\n";
    text += "• <b>Відправник:</b> " + Telegram.escapeHtml(senderDisplay) + "\n";
    text += "• <b>Виявлений лічильник:</b> " + Telegram.escapeHtml(meterName) + " [" + Telegram.escapeHtml(meterCode) + "]\n";
    
    var readingDisplay = (session.reading_value !== null && session.reading_value !== undefined)
      ? String(session.reading_value)
      : '<i>Не розпізнано</i>';
    text += "• <b>Розпізнаний показник:</b> <b>" + readingDisplay + "</b>\n";

    var confPercent = session.confidence_score ? Math.round(session.confidence_score * 100) : 0;
    var confQuality = confPercent >= 85 ? "Висока" : (confPercent >= 60 ? "Середня" : "Низька");
    text += "• <b>Точність AI:</b> " + confQuality + " (" + confPercent + "%)\n";

    if (session.issue_notes) {
      text += "• ⚠️ <b>Примітки:</b> <i>" + Telegram.escapeHtml(session.issue_notes) + "</i>\n";
    }

    return text;
  }

  /**
   * Builds the standard inline action keyboard.
   * @param {string} sessionId
   * @returns {Object} reply_markup
   */
  function buildMainKeyboard(sessionId) {
    return {
      inline_keyboard: [
        [
          { text: "✅ Підтвердити та зберегти", callback_data: "app:" + sessionId }
        ],
        [
          { text: "✏️ Змінити показник", callback_data: "edv:" + sessionId },
          { text: "🏷️ Змінити лічильник", callback_data: "chm:" + sessionId }
        ],
        [
          { text: "📸 Запросити повторне фото", callback_data: "ret:" + sessionId }
        ],
        [
          { text: "❌ Скасувати", callback_data: "can:" + sessionId }
        ]
      ]
    };
  }

  /**
   * Sends the confirmation card to the administrator DM.
   * @param {Object} session
   */
  function sendConfirmationCard(session) {
    var adminChatId = Config.getAdminChatId();
    var cardText = formatCardText(session);
    var keyboard = buildMainKeyboard(session.sessionId);

    var res;
    if (session.photoFileId) {
      res = Telegram.sendPhoto(adminChatId, session.photoFileId, cardText, {
        reply_markup: keyboard
      });
    } else {
      res = Telegram.sendMessage(adminChatId, cardText, {
        reply_markup: keyboard
      });
    }

    if (res.ok && res.result) {
      session.adminMessageId = res.result.message_id;
      StateService.updateSession(session.sessionId, { adminMessageId: res.result.message_id });
    }
  }

  /**
   * Handles button clicks from inline keyboards.
   * @param {Object} callbackQuery
   */
  function handleCallback(callbackQuery) {
    var queryId = callbackQuery.id;
    var data = callbackQuery.data || '';
    var message = callbackQuery.message;
    var messageId = message.message_id;
    var chatId = message.chat.id;

    var parts = data.split(':');
    var action = parts[0];
    var sessionId = parts[1];
    var extra = parts.slice(2).join(':');

    var session = StateService.getSession(sessionId);

    if (!session && action !== 'noop') {
      Telegram.answerCallbackQuery(queryId, "⚠️ Термін дії цієї картки завершився (минуло понад 6 годин).", true);
      return;
    }

    switch (action) {
      case 'app': // Approve and write to sheets
        handleApprove(queryId, session, chatId, messageId);
        break;

      case 'edv': // Edit reading value
        handleEditValueRequest(queryId, session, chatId);
        break;

      case 'chm': // Choose another meter
        handleChooseMeterMenu(queryId, session, chatId, messageId);
        break;

      case 'setm': // Set meter choice
        handleSetMeter(queryId, session, chatId, messageId, extra);
        break;

      case 'ret': // Show retake options
        handleRetakeMenu(queryId, session, chatId, messageId);
        break;

      case 'doret': // Execute retake notice
        handleExecuteRetake(queryId, session, chatId, messageId, extra);
        break;

      case 'back': // Back to main card buttons
        handleBackToMain(queryId, session, chatId, messageId);
        break;

      case 'can': // Cancel
        handleCancel(queryId, session, chatId, messageId);
        break;

      default:
        Telegram.answerCallbackQuery(queryId, "Невідома дія");
        break;
    }
  }

  function handleApprove(queryId, session, chatId, messageId) {
    if (!session.meter_id) {
      Telegram.answerCallbackQuery(queryId, "❌ Спочатку виберіть лічильник через кнопку 'Змінити лічильник'!", true);
      return;
    }

    if (session.reading_value === null || session.reading_value === undefined || isNaN(session.reading_value)) {
      Telegram.answerCallbackQuery(queryId, "❌ Показник не вказано! Натисніть 'Змінити показник'.", true);
      return;
    }

    Telegram.answerCallbackQuery(queryId, "⏳ Запис у Google Таблиці...");

    try {
      var writeResults = SheetsService.recordMeterReading(session.meter_id, session.reading_value);
      
      var summaryText = formatCardText(session);
      summaryText += "\n\n<b>✅ ПІДТВЕРДЖЕНО ТА ЗБЕРЕЖЕНО!</b>\n";
      
      writeResults.forEach(function (r) {
        if (r.status === 'success') {
          summaryText += "• " + Telegram.escapeHtml(r.address_name) + " (Рядок " + r.row + ", Стовпчик " + r.column + "): <b>OK</b>\n";
        } else {
          summaryText += "• ⚠️ " + Telegram.escapeHtml(r.address_name) + ": Помилка (" + Telegram.escapeHtml(r.error) + ")\n";
        }
      });

      // Update message text (or caption if photo)
      if (session.photoFileId) {
        Telegram.callApi('editMessageCaption', {
          chat_id: chatId,
          message_id: messageId,
          caption: summaryText,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      } else {
        Telegram.editMessageText(chatId, messageId, summaryText, {
          reply_markup: { inline_keyboard: [] }
        });
      }

      StateService.removeSession(session.sessionId);

    } catch (err) {
      console.error('Error approving reading: ' + err.message);
      Telegram.sendMessage(chatId, "❌ Помилка запису в таблицю: " + Telegram.escapeHtml(err.message));
    }
  }

  function handleEditValueRequest(queryId, session, chatId) {
    StateService.setAdminUserState(chatId, {
      action: 'awaiting_value_edit',
      sessionId: session.sessionId
    });

    Telegram.answerCallbackQuery(queryId, "Введіть новий числовий показник у відповідь");
    Telegram.sendMessage(
      chatId,
      "✏️ Будь ласка, надішліть новий числовий показник для <b>" + Telegram.escapeHtml(session.meter_id || 'лічильника') +
      "</b> (наприклад: <code>4829.5</code>):"
    );
  }

  function handleChooseMeterMenu(queryId, session, chatId, messageId) {
    Telegram.answerCallbackQuery(queryId, "Оберіть потрібний лічильник");

    var config = Config.getConfig();
    var buttons = [];

    if (config.properties) {
      config.properties.forEach(function (prop) {
        if (prop.meters) {
          prop.meters.forEach(function (m) {
            var label = prop.address_name.split(',')[0] + " — " + m.name_uk;
            if (m.meter_id === session.meter_id) {
              label = "✓ " + label;
            }
            buttons.push([
              {
                text: label,
                callback_data: "setm:" + session.sessionId + ":" + m.meter_id
              }
            ]);
          });
        }
      });
    }

    buttons.push([
      { text: "⬅️ Назад", callback_data: "back:" + session.sessionId }
    ]);

    Telegram.editMessageReplyMarkup(chatId, messageId, {
      inline_keyboard: buttons
    });
  }

  function handleSetMeter(queryId, session, chatId, messageId, newMeterId) {
    session.meter_id = newMeterId;
    StateService.updateSession(session.sessionId, { meter_id: newMeterId });

    Telegram.answerCallbackQuery(queryId, "Лічильник змінено!");

    refreshCardMessage(chatId, messageId, session);
  }

  function handleRetakeMenu(queryId, session, chatId, messageId) {
    Telegram.answerCallbackQuery(queryId, "Оберіть причину для перезйомки");

    var keyboard = {
      inline_keyboard: [
        [
          { text: "🌫️ Розмите фото", callback_data: "doret:" + session.sessionId + ":blur" }
        ],
        [
          { text: "💡 Відблиск світла / затемнено", callback_data: "doret:" + session.sessionId + ":glare" }
        ],
        [
          { text: "🔢 Циферблат перекрито", callback_data: "doret:" + session.sessionId + ":blocked" }
        ],
        [
          { text: "✍️ Написати власну причину", callback_data: "doret:" + session.sessionId + ":custom" }
        ],
        [
          { text: "⬅️ Назад", callback_data: "back:" + session.sessionId }
        ]
      ]
    };

    Telegram.editMessageReplyMarkup(chatId, messageId, keyboard);
  }

  function handleExecuteRetake(queryId, session, chatId, messageId, reasonKey) {
    if (reasonKey === 'custom') {
      StateService.setAdminUserState(chatId, {
        action: 'awaiting_retake_reason',
        sessionId: session.sessionId
      });
      Telegram.answerCallbackQuery(queryId, "Напишіть текст повідомлення");
      Telegram.sendMessage(
        chatId,
        "✍️ Напишіть коментар, що саме потрібно виправити на фото (його буде надіслано в чат мешканців з позначкою відправника):"
      );
      return;
    }

    var reasons = {
      blur: "Фото розмите, показники неможливо прочитати.",
      glare: "На циферблаті сильний відблиск світла або фото занадто темне.",
      blocked: "Циферблат або кому перекрито предметом/пальцем."
    };

    var note = reasons[reasonKey] || "Будь ласка, зробіть фото з іншого ракурсу.";
    dispatchRetakeNotice(session, note);

    Telegram.answerCallbackQuery(queryId, "Запит надіслано в чат мешканців!");

    // Mark card as retake requested
    var text = formatCardText(session);
    text += "\n\n<b>📸 ЗАПИТАНО ПЕРЕЗЙОМКУ У ЧАТІ:</b>\n<i>" + Telegram.escapeHtml(note) + "</i>";

    if (session.photoFileId) {
      Telegram.callApi('editMessageCaption', {
        chat_id: chatId,
        message_id: messageId,
        caption: text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
    } else {
      Telegram.editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: [] }
      });
    }

    StateService.removeSession(session.sessionId);
  }

  function handleBackToMain(queryId, session, chatId, messageId) {
    Telegram.answerCallbackQuery(queryId);
    refreshCardMessage(chatId, messageId, session);
  }

  function handleCancel(queryId, session, chatId, messageId) {
    Telegram.answerCallbackQuery(queryId, "Скасовано");
    var text = formatCardText(session);
    text += "\n\n<b>❌ ВІДХИЛЕНО АДМІНІСТРАТОРОМ</b>";

    if (session.photoFileId) {
      Telegram.callApi('editMessageCaption', {
        chat_id: chatId,
        message_id: messageId,
        caption: text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
    } else {
      Telegram.editMessageText(chatId, messageId, text, {
        reply_markup: { inline_keyboard: [] }
      });
    }

    StateService.removeSession(session.sessionId);
  }

  /**
   * Refreshes the message text and restores standard keyboard.
   */
  function refreshCardMessage(chatId, messageId, session) {
    var cardText = formatCardText(session);
    var keyboard = buildMainKeyboard(session.sessionId);

    if (session.photoFileId) {
      Telegram.callApi('editMessageCaption', {
        chat_id: chatId,
        message_id: messageId,
        caption: cardText,
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } else {
      Telegram.editMessageText(chatId, messageId, cardText, {
        reply_markup: keyboard
      });
    }
  }

  /**
   * Dispatches the retake prompt strictly to the meter's source chat.
   */
  function dispatchRetakeNotice(session, reasonText) {
    var found = Config.findMeterById(session.meter_id);
    var targetChatId = session.sourceChatId;

    if (found) {
      targetChatId = Config.resolveMeterChatId(found.property, found.meter) || targetChatId;
    }

    var meterName = found ? found.meter.name_uk : 'лічильника';
    var userTag = session.senderUsername ? ('@' + session.senderUsername) : (session.senderName || 'Шановний мешканець');

    var msg = "⚠️ " + userTag + ", будь ласка, зробіть чіткіше фото лічильника <b>" +
      Telegram.escapeHtml(meterName) + "</b>.\n\nПричина: " + Telegram.escapeHtml(reasonText);

    Telegram.sendMessage(targetChatId, msg, {
      reply_to_message_id: session.sourceMessageId
    });
  }

  /**
   * Handles free-form text input from Admin when in an active conversation state.
   * @param {string|number} adminChatId
   * @param {string} text
   * @returns {boolean} True if handled
   */
  function handleAdminText(adminChatId, text) {
    var state = StateService.getAdminUserState(adminChatId);
    if (!state) return false;

    var session = StateService.getSession(state.sessionId);
    if (!session) {
      StateService.clearAdminUserState(adminChatId);
      Telegram.sendMessage(adminChatId, "⚠️ Сесію не знайдено або термін її дії вичерпано.");
      return true;
    }

    if (state.action === 'awaiting_value_edit') {
      var sanitized = text.replace(',', '.').replace(/[^0-9.]/g, '');
      var num = parseFloat(sanitized);

      if (isNaN(num)) {
        Telegram.sendMessage(adminChatId, "❌ Будь ласка, введіть коректне число (наприклад: <code>4829.5</code>):");
        return true;
      }

      session.reading_value = num;
      StateService.updateSession(session.sessionId, { reading_value: num });
      StateService.clearAdminUserState(adminChatId);

      Telegram.sendMessage(adminChatId, "✅ Показник оновлено на <b>" + num + "</b>!");
      if (session.adminMessageId) {
        refreshCardMessage(adminChatId, session.adminMessageId, session);
      }
      return true;
    }

    if (state.action === 'awaiting_retake_reason') {
      dispatchRetakeNotice(session, text.trim());
      StateService.clearAdminUserState(adminChatId);

      Telegram.sendMessage(adminChatId, "✅ Запит на перезйомку надіслано в чат мешканців!");

      if (session.adminMessageId) {
        var cardText = formatCardText(session);
        cardText += "\n\n<b>📸 ЗАПИТАНО ПЕРЕЗЙОМКУ У ЧАТІ:</b>\n<i>" + Telegram.escapeHtml(text.trim()) + "</i>";

        if (session.photoFileId) {
          Telegram.callApi('editMessageCaption', {
            chat_id: adminChatId,
            message_id: session.adminMessageId,
            caption: cardText,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] }
          });
        } else {
          Telegram.editMessageText(adminChatId, session.adminMessageId, cardText, {
            reply_markup: { inline_keyboard: [] }
          });
        }
      }

      StateService.removeSession(session.sessionId);
      return true;
    }

    return false;
  }

  return {
    formatCardText: formatCardText,
    buildMainKeyboard: buildMainKeyboard,
    sendConfirmationCard: sendConfirmationCard,
    handleCallback: handleCallback,
    handleAdminText: handleAdminText,
    dispatchRetakeNotice: dispatchRetakeNotice
  };
})();
