const ZIP_CODE_REGEX = /\b\d{5}(?:-\d{4})?\b/;

const extractZipCode = (...values) => {
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;

    const match = text.match(ZIP_CODE_REGEX);
    if (match?.[0]) {
      return match[0].slice(0, 5);
    }
  }

  return "";
};

module.exports = extractZipCode;
