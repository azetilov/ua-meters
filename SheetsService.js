/**
 * SheetsService.js
 * Manages Google Sheets row discovery, formula replication, and reading updates.
 */

var SheetsService = (function () {
  var UKRAINIAN_MONTHS = [
    "Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
    "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"
  ];

  /**
   * Converts column letters like "A", "B", "AA" to 1-based index.
   * @param {string} columnLetter
   * @returns {number}
   */
  function columnLetterToIndex(columnLetter) {
    if (!columnLetter) return 1;
    var clean = columnLetter.trim().toUpperCase();
    var col = 0;
    for (var i = 0; i < clean.length; i++) {
      col = col * 26 + (clean.charCodeAt(i) - 64);
    }
    return col > 0 ? col : 1;
  }

  /**
   * Formats the target month label.
   * @param {Date} date
   * @returns {{monthName: string, year: number, label: string}}
   */
  function getMonthInfo(date) {
    var d = date || new Date();
    var monthIndex = d.getMonth();
    var year = d.getFullYear();
    var monthName = UKRAINIAN_MONTHS[monthIndex];
    return {
      monthIndex: monthIndex,
      monthName: monthName,
      year: year,
      label: monthName + " " + year
    };
  }

  /**
   * Finds or creates a row for the target month in the specified sheet.
   * Preserves formulas from the previous row if a new row is appended.
   * @param {Sheet} sheet
   * @param {Date} date
   * @returns {number} 1-based row index
   */
  function findOrCreateMonthRow(sheet, date) {
    var monthInfo = getMonthInfo(date);
    var lastRow = sheet.getLastRow();
    var lastCol = Math.max(sheet.getLastColumn(), 1);

    // 1. Scan Column A for month match
    if (lastRow >= 2) {
      var colAValues = sheet.getRange(1, 1, lastRow, 1).getValues();
      for (var r = 1; r < colAValues.length; r++) {
        var cellVal = colAValues[r][0];
        if (!cellVal) continue;

        if (cellVal instanceof Date) {
          if (cellVal.getMonth() === monthInfo.monthIndex && cellVal.getFullYear() === monthInfo.year) {
            return r + 1; // 1-indexed
          }
        } else {
          var strVal = String(cellVal).toLowerCase().trim();
          var targetFull = monthInfo.label.toLowerCase(); // "жовтень 2026"
          var targetName = monthInfo.monthName.toLowerCase(); // "жовтень"
          var numFormat1 = (monthInfo.monthIndex + 1) + "." + monthInfo.year; // "10.2026"
          var numFormat2 = "0" + (monthInfo.monthIndex + 1) + "." + monthInfo.year; // "010.2026"

          if (strVal === targetFull || strVal === targetName || strVal.indexOf(targetName) !== -1 || strVal === numFormat1 || strVal === numFormat2) {
            return r + 1;
          }
        }
      }
    }

    // 2. Row not found -> create new row
    var targetRow;
    if (lastRow < 2) {
      // Sheet is empty or header only
      targetRow = 2;
      sheet.getRange(targetRow, 1).setValue(monthInfo.label);
      return targetRow;
    }

    targetRow = lastRow + 1;
    var prevRowRange = sheet.getRange(lastRow, 1, 1, lastCol);
    var newRowRange = sheet.getRange(targetRow, 1, 1, lastCol);

    // Copy formats and formulas from previous row
    prevRowRange.copyTo(newRowRange, SpreadsheetApp.CopyPasteType.PASTE_NORMAL, false);

    // Clear static input values while leaving formulas intact
    var prevFormulas = prevRowRange.getFormulas()[0];
    for (var c = 1; c <= lastCol; c++) {
      var colFormula = prevFormulas[c - 1];
      if (c === 1) {
        // Set month label in column A
        sheet.getRange(targetRow, 1).setValue(monthInfo.label);
      } else if (!colFormula) {
        // Cell was a static number in the previous month -> clear it in the new row
        sheet.getRange(targetRow, c).clearContent();
      }
      // If colFormula exists, copyTo already replicated the adjusted relative formula
    }

    return targetRow;
  }

  /**
   * Writes reading value to a specific Google Sheet and column.
   * @param {string} spreadsheetId
   * @param {string} sheetTabName
   * @param {string} targetColumnLetter
   * @param {number} readingValue
   * @param {Date} [targetDate]
   * @returns {number} Target row number written to
   */
  function writeReadingToSheet(spreadsheetId, sheetTabName, targetColumnLetter, readingValue, targetDate) {
    if (!spreadsheetId) {
      throw new Error("Missing google_sheet_id in property configuration.");
    }

    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    var sheet = sheetTabName ? spreadsheet.getSheetByName(sheetTabName) : spreadsheet.getActiveSheet();

    if (!sheet) {
      // Fallback: search sheets or use active
      sheet = spreadsheet.getActiveSheet();
      if (!sheet) {
        throw new Error("Tab '" + sheetTabName + "' not found in spreadsheet: " + spreadsheetId);
      }
    }

    var colIndex = columnLetterToIndex(targetColumnLetter);
    var targetRow = findOrCreateMonthRow(sheet, targetDate);

    sheet.getRange(targetRow, colIndex).setValue(readingValue);
    SpreadsheetApp.flush();

    return targetRow;
  }

  /**
   * Records a confirmed reading for a meter across primary property and any shared target properties.
   * @param {string} meterId
   * @param {number} readingValue
   * @param {Date} [targetDate]
   * @returns {Array<Object>} Summary of written targets
   */
  function recordMeterReading(meterId, readingValue, targetDate) {
    var found = Config.findMeterById(meterId);
    if (!found) {
      throw new Error("Meter with ID '" + meterId + "' not found in configuration.");
    }

    var primaryProp = found.property;
    var meter = found.meter;
    var results = [];

    // 1. Primary property write
    try {
      var row1 = writeReadingToSheet(
        primaryProp.google_sheet_id,
        primaryProp.sheet_tab_name,
        meter.target_column,
        readingValue,
        targetDate
      );
      results.push({
        property_id: primaryProp.property_id,
        address_name: primaryProp.address_name,
        column: meter.target_column,
        row: row1,
        is_shared: false,
        status: "success"
      });
    } catch (err) {
      console.error("Error writing primary property reading: " + err.message);
      results.push({
        property_id: primaryProp.property_id,
        address_name: primaryProp.address_name,
        column: meter.target_column,
        is_shared: false,
        status: "error",
        error: err.message
      });
    }

    // 2. Shared targets synchronization
    if (meter.shared_targets && Array.isArray(meter.shared_targets)) {
      meter.shared_targets.forEach(function (shared) {
        var secondaryProp = Config.getPropertyById(shared.property_id);
        if (!secondaryProp) {
          results.push({
            property_id: shared.property_id,
            address_name: "Невідомий об'єкт (" + shared.property_id + ")",
            column: shared.target_column,
            is_shared: true,
            status: "error",
            error: "Property not found in config"
          });
          return;
        }

        try {
          var rowShared = writeReadingToSheet(
            secondaryProp.google_sheet_id,
            secondaryProp.sheet_tab_name,
            shared.target_column,
            readingValue,
            targetDate
          );
          results.push({
            property_id: secondaryProp.property_id,
            address_name: secondaryProp.address_name,
            column: shared.target_column,
            row: rowShared,
            is_shared: true,
            status: "success"
          });
        } catch (err) {
          console.error("Error writing shared property reading (" + shared.property_id + "): " + err.message);
          results.push({
            property_id: secondaryProp.property_id,
            address_name: secondaryProp.address_name,
            column: shared.target_column,
            is_shared: true,
            status: "error",
            error: err.message
          });
        }
      });
    }

    return results;
  }

  return {
    columnLetterToIndex: columnLetterToIndex,
    findOrCreateMonthRow: findOrCreateMonthRow,
    writeReadingToSheet: writeReadingToSheet,
    recordMeterReading: recordMeterReading,
    getMonthInfo: getMonthInfo
  };
})();
