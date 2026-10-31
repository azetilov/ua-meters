/**
 * Config.js
 * Configuration loader and helper utilities for Multi-Property Utility Meter Telegram Bot.
 */

var Config = (function () {
  /**
   * Retrieves the raw configuration object.
   * Priority:
   * 1. Script Properties ('CONFIG_JSON')
   * 2. Embedded Default Configuration
   */
  function getConfig() {
    var scriptProperties = PropertiesService.getScriptProperties();
    var configJson = scriptProperties.getProperty('CONFIG_JSON');

    if (configJson) {
      try {
        return JSON.parse(configJson);
      } catch (err) {
        console.error('Failed to parse CONFIG_JSON from Script Properties: ' + err.message);
      }
    }

    // Default configuration template if CONFIG_JSON is not yet set in Script Properties
    return {
      properties: [
        {
          property_id: "house_khreshchatyk_10",
          address_name: "вул. Хрещатик, 10",
          google_sheet_id: "",
          sheet_tab_name: "2026",
          source_chat_id: 0,
          meters: [
            {
              meter_id: "gas_main",
              name_uk: "Газ (Основний)",
              type: "gas",
              code: "GAS-9918",
              target_column: "B",
              description_for_ai: "Металевий корпус, червоні цифри після коми"
            },
            {
              meter_id: "water_kitchen",
              name_uk: "Вода (Кухня)",
              type: "water",
              code: "WTR-0012",
              target_column: "C",
              description_for_ai: "Лічильник води на кухні"
            },
            {
              meter_id: "water_bathroom",
              name_uk: "Вода (Ванна)",
              type: "water",
              code: "WTR-0013",
              target_column: "D",
              description_for_ai: "Лічильник води у ванній кімнаті"
            },
            {
              meter_id: "electricity_shared",
              name_uk: "Електроенергія (Спільний)",
              type: "electricity",
              code: "EL-4402",
              target_column: "E",
              description_for_ai: "Електронний цифровий дисплей, кВт·год, лічильник у коридорі",
              shared_targets: [
                {
                  property_id: "house_khreshchatyk_12",
                  target_column: "B"
                }
              ]
            },
            {
              meter_id: "water_boiler",
              name_uk: "Вода (Котельня)",
              type: "water",
              code: "WTR-0099",
              source_chat_id: 0,
              target_column: "F",
              description_for_ai: "Лічильник води в окремій котельні"
            }
          ]
        },
        {
          property_id: "house_khreshchatyk_12",
          address_name: "вул. Хрещатик, 12",
          google_sheet_id: "",
          sheet_tab_name: "2026",
          source_chat_id: 0,
          meters: [
            {
              meter_id: "gas_house_12",
              name_uk: "Газ",
              type: "gas",
              code: "GAS-1100",
              target_column: "C",
              description_for_ai: "Газовий лічильник будинку 12"
            }
          ]
        }
      ]
    };
  }

  function getTelegramBotToken() {
    var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set in Script Properties.');
    }
    return token.trim();
  }

  function getGeminiApiKey() {
    var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!key) {
      throw new Error('GEMINI_API_KEY is not set in Script Properties.');
    }
    return key.trim();
  }

  function getAdminChatId() {
    var adminId = PropertiesService.getScriptProperties().getProperty('ADMIN_CHAT_ID');
    if (!adminId) {
      throw new Error('ADMIN_CHAT_ID is not set in Script Properties.');
    }
    return String(adminId).trim();
  }

  /**
   * Resolves all meters that belong to a specific Telegram chat.
   * Follows the rule: meter.source_chat_id || property.source_chat_id.
   * @param {number|string} chatId
   * @returns {Array<{property: Object, meter: Object}>}
   */
  function getMetersForChat(chatId) {
    var strChatId = String(chatId).trim();
    var config = getConfig();
    var matched = [];

    if (!config.properties || !Array.isArray(config.properties)) {
      return matched;
    }

    config.properties.forEach(function (prop) {
      var defaultChatId = prop.source_chat_id ? String(prop.source_chat_id).trim() : null;

      if (prop.meters && Array.isArray(prop.meters)) {
        prop.meters.forEach(function (meter) {
          var meterChatId = meter.source_chat_id ? String(meter.source_chat_id).trim() : defaultChatId;
          if (meterChatId && meterChatId === strChatId) {
            matched.push({
              property: prop,
              meter: meter
            });
          }
        });
      }
    });

    return matched;
  }

  /**
   * Finds a meter and its owning property by meter_id.
   * @param {string} meterId
   * @returns {{property: Object, meter: Object}|null}
   */
  function findMeterById(meterId) {
    var config = getConfig();
    if (!config.properties) return null;

    for (var i = 0; i < config.properties.length; i++) {
      var prop = config.properties[i];
      if (prop.meters) {
        for (var j = 0; j < prop.meters.length; j++) {
          var m = prop.meters[j];
          if (m.meter_id === meterId) {
            return {
              property: prop,
              meter: m
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * Finds property by its property_id.
   * @param {string} propertyId
   * @returns {Object|null}
   */
  function getPropertyById(propertyId) {
    var config = getConfig();
    if (!config.properties) return null;

    for (var i = 0; i < config.properties.length; i++) {
      if (config.properties[i].property_id === propertyId) {
        return config.properties[i];
      }
    }
    return null;
  }

  /**
   * Returns a list of all distinct source chat IDs across all properties and meters.
   * Used for scheduled monthly reminders.
   * @returns {Array<string>}
   */
  function getDistinctSourceChats() {
    var config = getConfig();
    var chatMap = {};

    if (config.properties && Array.isArray(config.properties)) {
      config.properties.forEach(function (prop) {
        if (prop.source_chat_id) {
          chatMap[String(prop.source_chat_id).trim()] = true;
        }
        if (prop.meters && Array.isArray(prop.meters)) {
          prop.meters.forEach(function (m) {
            if (m.source_chat_id) {
              chatMap[String(m.source_chat_id).trim()] = true;
            }
          });
        }
      });
    }

    return Object.keys(chatMap).filter(function (id) {
      return id && id !== '0' && id !== 'null';
    });
  }

  /**
   * Resolves the target source chat ID where retake requests should be dispatched for a meter.
   * @param {Object} property
   * @param {Object} meter
   * @returns {string|number}
   */
  function resolveMeterChatId(property, meter) {
    if (meter && meter.source_chat_id) {
      return meter.source_chat_id;
    }
    if (property && property.source_chat_id) {
      return property.source_chat_id;
    }
    return 0;
  }

  return {
    getConfig: getConfig,
    getTelegramBotToken: getTelegramBotToken,
    getGeminiApiKey: getGeminiApiKey,
    getAdminChatId: getAdminChatId,
    getMetersForChat: getMetersForChat,
    findMeterById: findMeterById,
    getPropertyById: getPropertyById,
    getDistinctSourceChats: getDistinctSourceChats,
    resolveMeterChatId: resolveMeterChatId
  };
})();
