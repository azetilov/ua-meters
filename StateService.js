/**
 * StateService.js
 * Session state manager for asynchronous admin confirmations and interactions.
 */

var StateService = (function () {
  var CACHE_EXPIRY_SECONDS = 21600; // 6 hours

  function generateSessionId() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var i = 0; i < 8; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return 's_' + Date.now().toString(36) + '_' + id;
  }

  /**
   * Saves a pending verification session.
   * @param {Object} data
   * @returns {string} sessionId
   */
  function saveSession(data) {
    var sessionId = generateSessionId();
    data.sessionId = sessionId;
    data.createdAt = Date.now();

    var cache = CacheService.getScriptCache();
    cache.put('sess:' + sessionId, JSON.stringify(data), CACHE_EXPIRY_SECONDS);

    return sessionId;
  }

  /**
   * Retrieves a session by ID.
   * @param {string} sessionId
   * @returns {Object|null}
   */
  function getSession(sessionId) {
    if (!sessionId) return null;
    var cache = CacheService.getScriptCache();
    var raw = cache.get('sess:' + sessionId);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('Error parsing session ' + sessionId + ': ' + e.message);
      return null;
    }
  }

  /**
   * Updates an existing session.
   * @param {string} sessionId
   * @param {Object} partialData
   * @returns {Object|null}
   */
  function updateSession(sessionId, partialData) {
    var session = getSession(sessionId);
    if (!session) return null;

    for (var key in partialData) {
      if (partialData.hasOwnProperty(key)) {
        session[key] = partialData[key];
      }
    }

    var cache = CacheService.getScriptCache();
    cache.put('sess:' + sessionId, JSON.stringify(session), CACHE_EXPIRY_SECONDS);
    return session;
  }

  /**
   * Removes a session once confirmed or cancelled.
   * @param {string} sessionId
   */
  function removeSession(sessionId) {
    if (!sessionId) return;
    var cache = CacheService.getScriptCache();
    cache.remove('sess:' + sessionId);
  }

  /**
   * Sets current conversation state for an admin user (e.g. waiting for text input).
   * @param {string|number} adminUserId
   * @param {Object} stateData
   */
  function setAdminUserState(adminUserId, stateData) {
    var cache = CacheService.getScriptCache();
    cache.put('admin_state:' + adminUserId, JSON.stringify(stateData), 1800); // 30 minutes
  }

  /**
   * Gets current state of an admin user.
   * @param {string|number} adminUserId
   * @returns {Object|null}
   */
  function getAdminUserState(adminUserId) {
    var cache = CacheService.getScriptCache();
    var raw = cache.get('admin_state:' + adminUserId);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /**
   * Clears admin user state.
   * @param {string|number} adminUserId
   */
  function clearAdminUserState(adminUserId) {
    var cache = CacheService.getScriptCache();
    cache.remove('admin_state:' + adminUserId);
  }

  return {
    saveSession: saveSession,
    getSession: getSession,
    updateSession: updateSession,
    removeSession: removeSession,
    setAdminUserState: setAdminUserState,
    getAdminUserState: getAdminUserState,
    clearAdminUserState: clearAdminUserState
  };
})();
