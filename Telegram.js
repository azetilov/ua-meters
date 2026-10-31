/**
 * Telegram.js
 * Wrapper for Telegram Bot API operations using UrlFetchApp.
 */

var Telegram = (function () {
  var API_BASE = 'https://api.telegram.org/bot';

  function getBaseUrl() {
    return API_BASE + Config.getTelegramBotToken() + '/';
  }

  function getFileBaseUrl() {
    return 'https://api.telegram.org/file/bot' + Config.getTelegramBotToken() + '/';
  }

  /**
   * Helper to escape HTML characters for Telegram HTML mode.
   */
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Calls a Telegram Bot API method.
   * @param {string} method
   * @param {Object} payload
   * @returns {Object} JSON parsed response
   */
  function callApi(method, payload) {
    var url = getBaseUrl() + method;
    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    var result;
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      throw new Error('Telegram API returned non-JSON response (' + responseCode + '): ' + responseText);
    }

    if (!result.ok) {
      console.error('Telegram API error in ' + method + ': ' + responseText);
    }

    return result;
  }

  /**
   * Sends a text message to a chat.
   */
  function sendMessage(chatId, text, options) {
    var payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };

    if (options) {
      if (options.reply_markup) payload.reply_markup = options.reply_markup;
      if (options.reply_to_message_id) payload.reply_to_message_id = options.reply_to_message_id;
      if (options.disable_web_page_preview !== undefined) payload.disable_web_page_preview = options.disable_web_page_preview;
      if (options.parse_mode !== undefined) payload.parse_mode = options.parse_mode;
    }

    return callApi('sendMessage', payload);
  }

  /**
   * Sends a photo (either by file_id or external URL) to a chat with caption.
   */
  function sendPhoto(chatId, photoFileIdOrUrl, caption, options) {
    var payload = {
      chat_id: chatId,
      photo: photoFileIdOrUrl,
      caption: caption || '',
      parse_mode: 'HTML'
    };

    if (options) {
      if (options.reply_markup) payload.reply_markup = options.reply_markup;
      if (options.reply_to_message_id) payload.reply_to_message_id = options.reply_to_message_id;
    }

    return callApi('sendPhoto', payload);
  }

  /**
   * Answers a callback query from an inline keyboard.
   */
  function answerCallbackQuery(callbackQueryId, text, showAlert) {
    var payload = {
      callback_query_id: callbackQueryId
    };
    if (text) payload.text = text;
    if (showAlert) payload.show_alert = true;

    return callApi('answerCallbackQuery', payload);
  }

  /**
   * Edits the text of an existing message.
   */
  function editMessageText(chatId, messageId, text, options) {
    var payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: 'HTML'
    };

    if (options && options.reply_markup) {
      payload.reply_markup = options.reply_markup;
    }

    return callApi('editMessageText', payload);
  }

  /**
   * Edits message reply markup (inline keyboard).
   */
  function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    var payload = {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup
    };

    return callApi('editMessageReplyMarkup', payload);
  }

  /**
   * Gets file metadata from Telegram.
   */
  function getFile(fileId) {
    var res = callApi('getFile', { file_id: fileId });
    if (res.ok && res.result && res.result.file_path) {
      return res.result;
    }
    throw new Error('Failed to getFile for fileId: ' + fileId + ' -> ' + JSON.stringify(res));
  }

  /**
   * Downloads the raw file bytes from Telegram and constructs a clean, verified image Blob.
   * @param {string} fileId
   * @returns {Blob}
   */
  function getFileBlob(fileId) {
    var fileMeta = getFile(fileId);
    var downloadUrl = getFileBaseUrl() + fileMeta.file_path;
    var response = UrlFetchApp.fetch(downloadUrl, { muteHttpExceptions: true });

    if (response.getResponseCode() !== 200) {
      throw new Error('Failed to download file from ' + downloadUrl + ' (Code: ' + response.getResponseCode() + ')');
    }

    // Extract raw binary bytes
    var bytes = response.getContent();
    if (!bytes || bytes.length === 0) {
      throw new Error('Downloaded file payload from Telegram is empty (0 bytes).');
    }

    // Determine correct image MIME type
    var filePath = (fileMeta.file_path || '').toLowerCase();
    var mimeType = 'image/jpeg';
    if (filePath.endsWith('.png')) {
      mimeType = 'image/png';
    } else if (filePath.endsWith('.webp')) {
      mimeType = 'image/webp';
    }

    // Verify magic bytes: JPEG starts with 0xFF, 0xD8 (-1, -40 in signed byte)
    // PNG starts with 0x89, 0x50 (-119, 80 in signed byte)
    if (bytes.length >= 2) {
      if (bytes[0] === -1 && bytes[1] === -40) {
        mimeType = 'image/jpeg';
      } else if (bytes[0] === -119 && bytes[1] === 80) {
        mimeType = 'image/png';
      }
    }

    console.log('Successfully downloaded photo ' + fileId + ': ' + bytes.length + ' bytes, resolved MIME: ' + mimeType);
    return Utilities.newBlob(bytes, mimeType, 'meter_photo.jpg');
  }

  /**
   * Registers webhook URL with Telegram.
   * @param {string} webhookUrl
   * @param {boolean} [dropPendingUpdates=true] Drops any stuck retry queue.
   */
  function setWebhook(webhookUrl, dropPendingUpdates) {
    var shouldDrop = (dropPendingUpdates !== undefined) ? !!dropPendingUpdates : true;
    return callApi('setWebhook', {
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: shouldDrop
    });
  }

  /**
   * Checks current webhook status.
   */
  function getWebhookInfo() {
    return callApi('getWebhookInfo', {});
  }

  return {
    callApi: callApi,
    sendMessage: sendMessage,
    sendPhoto: sendPhoto,
    answerCallbackQuery: answerCallbackQuery,
    editMessageText: editMessageText,
    editMessageReplyMarkup: editMessageReplyMarkup,
    getFile: getFile,
    getFileBlob: getFileBlob,
    setWebhook: setWebhook,
    getWebhookInfo: getWebhookInfo,
    escapeHtml: escapeHtml
  };
})();
