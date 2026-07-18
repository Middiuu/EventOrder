function csvEscape(value) {
  const isText = value && typeof value === "object" && Object.hasOwn(value, "csvText");
  let output = String(isText ? value.csvText : (value ?? ""));
  const firstMeaningful = [...output].find(character => character > " ");
  if (isText && ["=", "+", "-", "@"].includes(firstMeaningful)) {
    output = `'${output}`;
  }
  if (/[",;\n]/.test(output)) return `"${output.replace(/"/g, '""')}"`;
  return output;
}

function csvText(value) {
  return { csvText: value ?? "" };
}

function centsToEuroString(cents) {
  return (Number(cents) / 100).toFixed(2).replace(".", ",");
}

module.exports = { csvEscape, csvText, centsToEuroString };
