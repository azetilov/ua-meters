/**
 * Gemini.js
 * Multimodal AI vision analysis using Google Gemini API for utility meter reading.
 * Features automated multi-model failover, backoff retry for 503/429, and dynamic model discovery.
 */

var Gemini = (function () {
  // Candidate models prioritized for visual OCR & reliability
  var DEFAULT_MODEL = 'gemini-3.5-flash-lite';
  var CANDIDATE_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
  ];

  function getModel() {
    var custom = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
    var model = (custom && custom.trim()) ? custom.trim() : DEFAULT_MODEL;
    return model.replace(/^models\//, '');
  }

  /**
   * Queries the Gemini API to list all models available for the configured API key.
   * @returns {Array<string>} List of model identifiers supporting generateContent
   */
  function listAvailableModels() {
    var apiKey = Config.getGeminiApiKey();
    var url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;

    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      console.error('Failed to list Gemini models: ' + response.getContentText());
      return [];
    }

    try {
      var data = JSON.parse(response.getContentText());
      if (data.models && Array.isArray(data.models)) {
        return data.models
          .filter(function (m) {
            return m.supportedGenerationMethods && m.supportedGenerationMethods.indexOf('generateContent') !== -1;
          })
          .map(function (m) {
            return m.name.replace(/^models\//, '');
          });
      }
    } catch (e) {
      console.error('Error parsing listModels response: ' + e.message);
    }
    return [];
  }

  /**
   * Discovers the best active flash model from the API key's available model list.
   * @returns {string|null}
   */
  function discoverBestModel() {
    var available = listAvailableModels();
    console.log("Available Gemini models for this key: " + JSON.stringify(available));

    if (!available || available.length === 0) {
      return null;
    }

    // 1. Prefer flash-lite or flash models
    var preferredOrder = [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash'
    ];

    for (var i = 0; i < preferredOrder.length; i++) {
      var cand = preferredOrder[i];
      for (var j = 0; j < available.length; j++) {
        if (available[j] === cand || available[j].indexOf(cand) !== -1) {
          return available[j];
        }
      }
    }

    var anyFlash = available.filter(function (m) { return m.indexOf('flash') !== -1; });
    if (anyFlash.length > 0) return anyFlash[0];

    return available[0];
  }

  /**
   * Builds the system and user instructions for meter recognition.
   * @param {Array<{property: Object, meter: Object}>} candidateMeters
   * @returns {string}
   */
  function buildSystemPrompt(candidateMeters) {
    var prompt = "You are an expert optical character recognition (OCR) and computer vision specialist dedicated to reading utility meters (gas, electricity, water).\n\n";
    prompt += "TASK:\n";
    prompt += "Carefully inspect the provided image of the utility meter and accurately extract:\n";
    prompt += "1. 'meter_type': 'gas', 'electricity', 'water', or 'unknown'.\n";
    prompt += "2. 'meter_code': The visible serial number / factory number printed on the meter casing, dial plate, or barcode label (e.g. '4688072', '007542146034310', '007509124014617').\n";
    prompt += "3. 'reading_value': The current meter reading as a numeric value.\n";
    prompt += "4. 'confidence_score': A float between 0.0 and 1.0 representing your confidence.\n";
    prompt += "5. 'recognized': boolean (true if digits are readable).\n\n";

    if (candidateMeters && candidateMeters.length > 0) {
      prompt += "EXPECTED METERS FOR THIS ADDRESS/CHAT:\n";
      candidateMeters.forEach(function (item, idx) {
        var p = item.property;
        var m = item.meter;
        prompt += (idx + 1) + ". Property: " + p.address_name + "\n";
        prompt += "   - Meter Name: " + (m.name_en || m.name_uk) + "\n";
        prompt += "   - Meter ID: \"" + m.meter_id + "\"\n";
        prompt += "   - Type: " + m.type + "\n";
        prompt += "   - Serial Number: \"" + (m.code || 'not specified') + "\"\n";
        if (m.description_for_ai) {
          prompt += "   - Visual hints: " + m.description_for_ai + "\n";
        }
      });
      prompt += "\nIf the meter serial number or visual features match one of the expected meters above, populate 'meter_id' with its exact meter_id.\n";
      prompt += "CRITICAL: If the detected serial number does NOT match any candidate in the list, STILL extract the reading value, meter_type, and meter_code, set recognized: true, and set meter_id: null!\n\n";
    } else {
      prompt += "Extract the meter type, serial number, and reading independently. Set meter_id: null.\n\n";
    }

    prompt += "RULES FOR READING NUMERIC DIGITS:\n";
    prompt += "- On mechanical roller/drum counters, the main black digits represent integer units.\n";
    prompt += "- Digits inside a RED box, in RED font color, or after a red decimal comma represent decimal fractions (tenths, hundredths).\n";
    prompt += "  * Example: A gas meter with black digits '29650' and red digits '12' has reading 29650.12 (or 29650 if tenths are omitted).\n";
    prompt += "  * Example: An electricity counter with black digits '27006' and last digit '7' inside a red border has reading 27006.7.\n";
    prompt += "  * Example: An electricity counter with black digits '10404' and last digit '6' or '7' in red frame has reading 10404.6.\n";
    prompt += "- If a mechanical drum digit is halfway rotated, select the lower digit or the digit that is most completely visible.\n";
    prompt += "- Ignore reflections, protective plastic wrapping, glare, or minor dust if the digits underneath are discernible.\n";
    prompt += "- Even if the photo is taken at an angle, in grayscale/black-and-white, or in dim light, read the visible digits.\n";
    prompt += "- ONLY set recognized: false if the photo is pure black, completely out of focus with zero readable numbers, or not a utility meter at all.\n";
    prompt += "- Return strictly valid JSON conforming to the requested schema.\n";

    return prompt;
  }

  /**
   * Analyzes a meter photo blob using Gemini Vision with automated model fallback and 503 recovery.
   * @param {Blob} imageBlob
   * @param {Array<{property: Object, meter: Object}>} candidateMeters
   * @returns {Object} Structured recognition result
   */
  function analyzeMeterImage(imageBlob, candidateMeters) {
    var apiKey = Config.getGeminiApiKey();
    var primaryModel = getModel();

    // Build deduplicated prioritized list of models to try
    var modelsToTry = [primaryModel];
    CANDIDATE_MODELS.forEach(function (m) {
      if (modelsToTry.indexOf(m) === -1) {
        modelsToTry.push(m);
      }
    });

    // Guarantee valid image MIME type
    var rawMime = (imageBlob.getContentType() || '').toLowerCase();
    var mimeType = 'image/jpeg';
    if (rawMime.indexOf('png') !== -1) {
      mimeType = 'image/png';
    } else if (rawMime.indexOf('webp') !== -1) {
      mimeType = 'image/webp';
    } else if (rawMime.indexOf('heic') !== -1) {
      mimeType = 'image/heic';
    }

    var base64Data = Utilities.base64Encode(imageBlob.getBytes());
    var promptText = buildSystemPrompt(candidateMeters);

    var requestBody = {
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data
              }
            },
            {
              text: promptText
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            recognized: {
              type: "BOOLEAN",
              description: "true if a meter was detected and value read; false only if completely unreadable"
            },
            meter_id: {
              type: "STRING",
              nullable: true,
              description: "Matched meter_id from expected meters, or null if no match"
            },
            meter_type: {
              type: "STRING",
              enum: ["gas", "water", "electricity", "unknown"]
            },
            meter_code: {
              type: "STRING",
              nullable: true,
              description: "Detected serial number / barcode printed on the meter"
            },
            reading_value: {
              type: "NUMBER",
              nullable: true,
              description: "Numeric consumption reading. Fractional digits in red box should be decimals (e.g. 29650.12 or 27006.7)"
            },
            confidence_score: {
              type: "NUMBER",
              description: "Confidence rating between 0.0 and 1.0"
            },
            issue_notes: {
              type: "STRING",
              description: "Notes or description of meter appearance"
            }
          },
          required: ["recognized", "meter_type", "confidence_score", "issue_notes"]
        }
      }
    };

    var lastError = null;

    for (var i = 0; i < modelsToTry.length; i++) {
      var currentModel = modelsToTry[i];
      var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + currentModel + ':generateContent?key=' + apiKey;

      console.log("Calling Gemini API with model: " + currentModel + " (attempt " + (i + 1) + "/" + modelsToTry.length + ")...");

      var options = {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      };

      var response = UrlFetchApp.fetch(url, options);
      var statusCode = response.getResponseCode();
      var responseText = response.getContentText();

      // Case 1: Success!
      if (statusCode === 200) {
        console.log("Gemini API call succeeded with model: " + currentModel);
        if (currentModel !== primaryModel) {
          PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', currentModel);
        }
        return parseGeminiResponse(responseText);
      }

      // Case 2: High Demand (503) or Rate Limit (429) -> Backoff and try next model
      if (statusCode === 503 || statusCode === 429) {
        console.warn("Model '" + currentModel + "' returned HTTP " + statusCode + " (High demand / spike). Waiting 1.5s before fallback...");
        lastError = "HTTP " + statusCode + " (" + currentModel + "): " + responseText;
        if (i < modelsToTry.length - 1) {
          Utilities.sleep(1500);
        }
        continue;
      }

      // Case 3: Model Not Found (404) or Deprecated
      if (statusCode === 404) {
        console.warn("Model '" + currentModel + "' not found (HTTP 404). Trying next available model...");
        lastError = "HTTP 404 (" + currentModel + "): " + responseText;
        continue;
      }

      // Case 4: Schema error (400) fallback without schema
      if (statusCode === 400 && responseText.indexOf('responseSchema') !== -1) {
        console.warn("Model '" + currentModel + "' does not support responseSchema. Retrying without schema...");
        delete requestBody.generationConfig.responseSchema;
        options.payload = JSON.stringify(requestBody);
        var retryRes = UrlFetchApp.fetch(url, options);
        if (retryRes.getResponseCode() === 200) {
          return parseGeminiResponse(retryRes.getContentText());
        }
      }

      lastError = "HTTP " + statusCode + " (" + currentModel + "): " + responseText;
      console.error("Gemini API Error: " + lastError);
    }

    // Dynamic model discovery as last resort
    console.warn("Predefined models failed. Attempting dynamic model discovery...");
    var discovered = discoverBestModel();
    if (discovered && modelsToTry.indexOf(discovered) === -1) {
      console.log("Trying dynamically discovered model: " + discovered);
      var fallbackUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + discovered + ':generateContent?key=' + apiKey;
      var fallbackRes = UrlFetchApp.fetch(fallbackUrl, options);
      if (fallbackRes.getResponseCode() === 200) {
        PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', discovered);
        return parseGeminiResponse(fallbackRes.getContentText());
      }
    }

    throw new Error("Gemini API failed across all available models. Last error: " + lastError);
  }

  /**
   * Parses and cleans model response into structured JSON.
   */
  function parseGeminiResponse(responseText) {
    var resultJson;
    try {
      resultJson = JSON.parse(responseText);
    } catch (e) {
      throw new Error('Failed to parse Gemini API response: ' + responseText);
    }

    var textResponse = '';
    if (resultJson.candidates && resultJson.candidates.length > 0 &&
        resultJson.candidates[0].content && resultJson.candidates[0].content.parts &&
        resultJson.candidates[0].content.parts.length > 0) {
      for (var p = 0; p < resultJson.candidates[0].content.parts.length; p++) {
        if (resultJson.candidates[0].content.parts[p].text) {
          textResponse += resultJson.candidates[0].content.parts[p].text;
        }
      }
    } else {
      throw new Error('Gemini returned empty candidate content: ' + responseText);
    }

    // Clean JSON markdown code blocks if any
    var cleanedText = textResponse.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    try {
      var parsed = JSON.parse(cleanedText);
      if (typeof parsed.reading_value === 'string') {
        var sanitized = parsed.reading_value.replace(',', '.').replace(/[^0-9.]/g, '');
        parsed.reading_value = parseFloat(sanitized);
      }
      if (typeof parsed.confidence_score === 'string') {
        parsed.confidence_score = parseFloat(parsed.confidence_score);
      }
      return parsed;
    } catch (err) {
      console.error('Failed to parse model JSON: ' + cleanedText);
      return {
        recognized: false,
        meter_id: null,
        meter_type: "unknown",
        meter_code: null,
        reading_value: null,
        confidence_score: 0.0,
        issue_notes: "Не вдалося розібрати відповідь AI: " + err.message
      };
    }
  }

  return {
    analyzeMeterImage: analyzeMeterImage,
    buildSystemPrompt: buildSystemPrompt,
    listAvailableModels: listAvailableModels,
    discoverBestModel: discoverBestModel,
    getModel: getModel
  };
})();
