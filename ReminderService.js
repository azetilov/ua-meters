/**
 * ReminderService.js
 * Automated reminders sent to registered tenant chats on the 25th of every month.
 */

var ReminderService = (function () {

  /**
   * Generates localized reminder text with expected meters for a specific chat.
   * @param {string|number} chatId
   * @returns {string}
   */
  function buildReminderMessage(chatId) {
    var meters = Config.getMetersForChat(chatId);

    var text = "🔔 <b>Нагадування про подачу показників лічильників!</b>\n\n";
    text += "Доброго дня! Сьогодні 25-те число місяця. Будь ласка, сфотографуйте та надішліть у цей чат актуальні фотографії лічильників";

    if (meters && meters.length > 0) {
      text += ":\n";
      meters.forEach(function (item) {
        var m = item.meter;
        text += "• <b>" + Telegram.escapeHtml(m.name_uk) + "</b>";
        if (m.code) {
          text += " (№ " + Telegram.escapeHtml(m.code) + ")";
        }
        text += "\n";
      });
    } else {
      text += " (газ, вода, електроенергія).\n";
    }

    text += "\n📸 <i>Порада: переконайтеся, що циферблат та кома чітко освітлені і на них немає відблисків спалаху. Дякуємо!</i>";

    return text;
  }

  /**
   * Dispatches the monthly reminder to all configured tenant chats.
   */
  function sendMonthlyReminders() {
    var chatIds = Config.getDistinctSourceChats();
    console.log("Sending monthly reminders to " + chatIds.length + " chat(s)...");

    var adminChatId = '';
    try {
      adminChatId = Config.getAdminChatId();
    } catch (e) {}

    var sentCount = 0;
    var errors = [];

    chatIds.forEach(function (chatId) {
      try {
        var msg = buildReminderMessage(chatId);
        var res = Telegram.sendMessage(chatId, msg);
        if (res.ok) {
          sentCount++;
        } else {
          errors.push("Chat " + chatId + ": " + JSON.stringify(res));
        }
      } catch (err) {
        errors.push("Chat " + chatId + ": " + err.message);
      }
    });

    console.log("Reminders sent successfully to " + sentCount + "/" + chatIds.length + " chats.");

    // Inform admin about the reminder dispatch
    if (adminChatId) {
      var adminNotice = "📢 <b>Щомісячне нагадування розіслано</b>\n\n" +
        "• Успішно надіслано в чатів: <b>" + sentCount + "</b>\n";
      if (errors.length > 0) {
        adminNotice += "• ⚠️ Помилки:\n" + errors.map(function(e) { return "  - " + Telegram.escapeHtml(e); }).join("\n");
      }
      Telegram.sendMessage(adminChatId, adminNotice);
    }
  }

  /**
   * Installs or refreshes the automatic time-driven trigger for the 25th of every month at 09:00 Kyiv time.
   */
  function setupMonthlyTrigger() {
    // Delete any existing triggers for sendMonthlyReminders
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'triggerMonthlyReminders') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }

    // Google Apps Script doesn't have a direct "every month on day 25" trigger type,
    // but supports onMonthDay(25).atHour(9).
    ScriptApp.newTrigger('triggerMonthlyReminders')
      .timeBased()
      .onMonthDay(25)
      .atHour(9)
      .inTimezone("Europe/Kyiv")
      .create();

    console.log("Successfully created monthly trigger for 25th at 09:00 AM Europe/Kyiv.");
  }

  return {
    buildReminderMessage: buildReminderMessage,
    sendMonthlyReminders: sendMonthlyReminders,
    setupMonthlyTrigger: setupMonthlyTrigger
  };
})();

/**
 * Top-level global trigger handler for GAS Time-driven trigger.
 */
function triggerMonthlyReminders() {
  ReminderService.sendMonthlyReminders();
}
