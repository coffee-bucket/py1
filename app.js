const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const defaultColumns = {
  name: { label: "내용", min: 120, max: 635 },
  spec: { label: "규격", min: 635, max: 730 },
  quantity: { label: "수량", min: 730, max: 860 },
  unitPrice: { label: "예상단가", min: 860, max: 1040 },
};

const state = {
  file: null,
  rows: [],
  debug: [],
  columns: structuredClone(defaultColumns),
};

const els = {
  file: document.querySelector("#pdfFile"),
  dropzone: document.querySelector("#dropzone"),
  extract: document.querySelector("#extractBtn"),
  clear: document.querySelector("#sampleBtn"),
  status: document.querySelector("#status"),
  columnInputs: document.querySelector("#columnInputs"),
  rowTolerance: document.querySelector("#rowTolerance"),
  resetColumns: document.querySelector("#resetColumns"),
  resultTitle: document.querySelector("#resultTitle"),
  resultBody: document.querySelector("#resultBody"),
  copyJson: document.querySelector("#copyJson"),
  downloadCsv: document.querySelector("#downloadCsv"),
  debugLog: document.querySelector("#debugLog"),
};

renderColumnInputs();

els.file.addEventListener("change", () => {
  const [file] = els.file.files;
  setFile(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("is-dragging");
  });
});

els.dropzone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  setFile(file);
});

els.extract.addEventListener("click", extractPdf);
els.clear.addEventListener("click", clearResults);
els.resetColumns.addEventListener("click", () => {
  state.columns = structuredClone(defaultColumns);
  renderColumnInputs();
  log("컬럼 범위를 기본값으로 되돌렸습니다.");
});

els.copyJson.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(state.rows, null, 2));
  setStatus("JSON을 클립보드에 복사했습니다.");
});

els.downloadCsv.addEventListener("click", () => {
  const csv = toCsv(state.rows);
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "quote-items.csv";
  a.click();
  URL.revokeObjectURL(url);
});

function setFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    setStatus("PDF 파일만 업로드할 수 있습니다.", true);
    return;
  }

  state.file = file;
  els.extract.disabled = false;
  setStatus(`${file.name} 선택됨. 추출하기를 누르세요.`);
}

async function extractPdf() {
  if (!state.file) return;

  clearResults();
  setStatus("PDF 텍스트를 읽는 중입니다...");

  try {
    const pdfjsLib = await loadPdfJs();
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

    const data = await state.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const allRows = [];

    log(`페이지 ${pdf.numPages}개를 확인합니다.`);

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items = normalizeItems(textContent.items, pageNumber);
      const header = detectHeader(items);
      const pageColumns = header ? columnsFromHeader(header) : state.columns;
      const gmarketRows = parseGmarketQuote(items, pageNumber);
      const pageRows = gmarketRows.length > 0
        ? gmarketRows
        : parseRows(items, pageColumns, header, pageNumber);

      allRows.push(...pageRows);
      log(
        `${pageNumber}쪽: 텍스트 ${items.length}개, ` +
        `${gmarketRows.length > 0 ? "G마켓 규칙 적용" : header ? "헤더 자동 인식" : "수동 컬럼 범위 사용"}, ` +
        `품목 ${pageRows.length}개`
      );
    }

    state.rows = allRows.map((row, index) => ({ no: index + 1, ...row }));
    renderResults();
    setStatus(`완료했습니다. 품목 ${state.rows.length}개를 추출했습니다.`);
  } catch (error) {
    console.error(error);
    setStatus(`추출하지 못했습니다: ${error.message}`, true);
    log(error.stack || error.message);
  }
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  const module = await import(PDFJS_URL);
  window.pdfjsLib = module;
  return module;
}

function normalizeItems(items, pageNumber) {
  return items
    .map((item) => {
      const text = normalizeText(item.str);
      const [, , , height, x, y] = item.transform;
      return {
        text,
        x,
        y,
        endX: x + (item.width || 0),
        height: Math.abs(height || 0),
        page: pageNumber,
      };
    })
    .filter((item) => item.text);
}

function detectHeader(items) {
  const lines = groupByLine(items, 5);
  const headerLine = lines.find((line) => {
    const joined = line.items.map((item) => item.text).join(" ");
    return joined.includes("내용") &&
      joined.includes("규격") &&
      joined.includes("수량") &&
      (joined.includes("예상단가") || joined.includes("단가"));
  });

  if (!headerLine) return null;

  const findX = (word) => {
    const item = headerLine.items.find((candidate) => candidate.text.includes(word));
    return item?.x ?? null;
  };

  return {
    y: headerLine.y,
    nameX: findX("내용"),
    specX: findX("규격"),
    quantityX: findX("수량"),
    unitPriceX: findX("예상단가") ?? findX("단가"),
  };
}

function columnsFromHeader(header) {
  const fallback = state.columns;
  const xs = {
    name: header.nameX ?? fallback.name.min,
    spec: header.specX ?? fallback.spec.min,
    quantity: header.quantityX ?? fallback.quantity.min,
    unitPrice: header.unitPriceX ?? fallback.unitPrice.min,
  };

  const nameSpec = midpoint(xs.name, xs.spec);
  const specQty = midpoint(xs.spec, xs.quantity);
  const qtyPrice = midpoint(xs.quantity, xs.unitPrice);

  return {
    name: { ...fallback.name, min: Math.max(0, xs.name - 35), max: nameSpec },
    spec: { ...fallback.spec, min: nameSpec, max: specQty },
    quantity: { ...fallback.quantity, min: specQty, max: qtyPrice },
    unitPrice: { ...fallback.unitPrice, min: qtyPrice, max: xs.unitPrice + 180 },
  };
}

function parseGmarketQuote(items, pageNumber) {
  const fullText = items.map((item) => item.text).join(" ");
  const looksLikeGmarket = /상품명|필수선택|추가구성/.test(fullText) &&
    /공급\s*가액|공급가액/.test(fullText);

  if (!looksLikeGmarket) {
    return [];
  }

  const lines = groupByLine(items, 4);
  const columnRows = parseGmarketColumnRows(lines, pageNumber);
  if (columnRows.length > 0) {
    log("G마켓 규칙: 표 헤더를 기준으로 상품명/필수선택/추가구성, 수량, 공급가액을 읽었습니다.");
    return columnRows;
  }

  const blocks = [];
  let current = createGmarketBlock();

  lines.forEach((line) => {
    const text = line.items.map((item) => item.text).join(" ");

    if (/상품명/.test(text) && hasGmarketBlockContent(current)) {
      blocks.push(current);
      current = createGmarketBlock();
    }

    const name = valueAfterLabel(line.items, ["상품명"]);
    const requiredOption = valueAfterLabel(line.items, ["필수선택", "필수 선택"]);
    const addOn = valueAfterLabel(line.items, ["추가구성", "추가 구성"]);
    const quantity = valueAfterLabel(line.items, ["수량"]);
    const supplyAmount = valueAfterLabel(line.items, ["공급가액", "공급 가액"]);

    pushGmarketContent(current, name);
    pushGmarketContent(current, requiredOption);
    pushGmarketContent(current, addOn);

    const quantityNumber = toNumber(quantity);
    if (quantityNumber) current.quantity = quantityNumber;

    const supplyAmountNumber = toNumber(supplyAmount);
    if (supplyAmountNumber) current.supplyAmount = supplyAmountNumber;
  });

  if (hasGmarketBlockContent(current)) {
    blocks.push(current);
  }

  const rows = blocks
    .map((block) => {
      const unitPrice = block.quantity && block.supplyAmount
        ? Math.round(block.supplyAmount / block.quantity)
        : null;

      return {
        name: cleanGmarketName(block.contents.join(" / ")),
        spec: "개",
        quantity: block.quantity,
        unitPrice,
        page: pageNumber,
      };
    })
    .filter((row) => row.name && row.quantity && row.unitPrice);

  if (rows.length > 0) {
    log("G마켓 규칙: 예상단가는 할인금액을 제외하고 공급가액 ÷ 수량으로 계산했습니다.");
  } else {
    const preview = lines.slice(0, 16).map((line) => lineText(line.items)).filter(Boolean);
    log(`G마켓 문서는 감지했지만 품목을 못 찾았습니다. 읽힌 행 미리보기:\n${preview.join("\n")}`);
  }

  return rows;
}

function parseGmarketColumnRows(lines, pageNumber) {
  const header = detectGmarketColumnHeader(lines);
  if (!header) return [];

  return lines
    .filter((line) => line.y < header.y - 3)
    .map((line) => rowFromGmarketColumns(line.items, header.columns, pageNumber))
    .filter((row) => row.name && row.quantity && row.unitPrice);
}

function detectGmarketColumnHeader(lines) {
  for (const line of lines) {
    const text = line.items.map((item) => item.text).join(" ");
    if (!/상품명/.test(text) || !/수량/.test(text) || !/공급\s*가액|공급가액/.test(text)) {
      continue;
    }

    const point = (labels) => {
      const item = line.items.find((candidate) => {
        return labels.some((label) => compactText(candidate.text).includes(compactText(label)));
      });
      return item ? item.x : null;
    };

    const points = {
      name: point(["상품명"]),
      requiredOption: point(["필수선택", "필수 선택"]),
      addOn: point(["추가구성", "추가 구성"]),
      quantity: point(["수량"]),
      supplyAmount: point(["공급가액", "공급 가액"]),
      discount: point(["할인금액", "할인 금액"]),
    };

    if (points.name === null || points.quantity === null || points.supplyAmount === null) {
      continue;
    }

    return {
      y: line.y,
      columns: columnsFromGmarketPoints(points),
    };
  }

  return null;
}

function columnsFromGmarketPoints(points) {
  const ordered = Object.entries(points)
    .filter(([, x]) => x !== null)
    .sort((a, b) => a[1] - b[1]);

  const boundaryAfter = (key, fallbackWidth) => {
    const index = ordered.findIndex(([candidate]) => candidate === key);
    if (index < 0) return null;
    const currentX = ordered[index][1];
    const nextX = ordered[index + 1]?.[1];
    return nextX ? midpoint(currentX, nextX) : currentX + fallbackWidth;
  };

  const boundaryBefore = (key, fallbackWidth) => {
    const index = ordered.findIndex(([candidate]) => candidate === key);
    if (index < 0) return null;
    const currentX = ordered[index][1];
    const previousX = ordered[index - 1]?.[1];
    return previousX ? midpoint(previousX, currentX) : Math.max(0, currentX - fallbackWidth);
  };

  const columns = {};
  ["name", "requiredOption", "addOn", "quantity", "supplyAmount"].forEach((key) => {
    const x = points[key];
    if (x === null) return;
    columns[key] = {
      min: boundaryBefore(key, key === "name" ? 30 : 45),
      max: boundaryAfter(key, key === "supplyAmount" ? 120 : 90),
    };
  });

  return columns;
}

function rowFromGmarketColumns(items, columns, pageNumber) {
  const cell = (key) => {
    const column = columns[key];
    if (!column) return "";
    return items
      .filter((item) => item.x >= column.min && item.x < column.max)
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join(" ")
      .trim();
  };

  const contents = [
    cell("name"),
    cell("requiredOption"),
    cell("addOn"),
  ].map(cleanGmarketName).filter(Boolean);

  const quantity = toNumber(cell("quantity"));
  const supplyAmount = toNumber(cell("supplyAmount"));
  const unitPrice = quantity && supplyAmount ? Math.round(supplyAmount / quantity) : null;

  return {
    name: contents.join(" / "),
    spec: "개",
    quantity,
    unitPrice,
    page: pageNumber,
  };
}

function createGmarketBlock() {
  return {
    contents: [],
    quantity: null,
    supplyAmount: null,
  };
}

function hasGmarketBlockContent(block) {
  return block.contents.length > 0 || block.quantity || block.supplyAmount;
}

function pushGmarketContent(block, value) {
  const cleaned = cleanGmarketName(value);
  if (cleaned && !block.contents.includes(cleaned)) {
    block.contents.push(cleaned);
  }
}

function cleanGmarketName(text) {
  return cleanCell(text)
    .replace(/^(선택|없음|해당없음|무료|기본)\s*$/g, "")
    .replace(/\s*\/\s*$/g, "");
}

function valueAfterLabel(items, labels) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const nextLabelPattern = /상품명|필수\s*선택|필수선택|추가\s*구성|추가구성|수량|공급\s*가액|공급가액|할인\s*금액|할인금액|판매가|합계/;

  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    const label = labels.find((candidate) => compactText(item.text).includes(compactText(candidate)));
    if (!label) continue;

    const inlineValue = textAfterLabel(item.text, label);
    const rightValues = [];

    for (const candidate of sorted.slice(index + 1)) {
      if (nextLabelPattern.test(candidate.text)) break;
      rightValues.push(candidate.text);
    }

    return cleanCell([inlineValue, ...rightValues].filter(Boolean).join(" "));
  }

  return "";
}

function textAfterLabel(text, label) {
  const normalized = normalizeText(text);
  const compactLabel = compactText(label);
  const compact = compactText(normalized);
  const compactIndex = compact.indexOf(compactLabel);

  if (compactIndex < 0) return "";
  if (compact === compactLabel) return "";

  const labelIndex = normalized.indexOf(label);
  if (labelIndex < 0) return "";

  return normalized
    .slice(labelIndex + label.length)
    .replace(/^[:：|\-\s]+/, "")
    .trim();
}

function parseRows(items, columns, header, pageNumber) {
  const tolerance = Number(els.rowTolerance.value) || 4;
  const candidateItems = items.filter((item) => {
    return !header || item.y < header.y - tolerance;
  });

  const lines = groupByLine(candidateItems, tolerance);
  const rows = lines
    .map((line) => {
      const coordinateRow = rowFromLine(line.items, columns, pageNumber);
      if (isUsefulRow(coordinateRow)) return coordinateRow;
      return rowFromTokens(line.items, pageNumber);
    })
    .filter(isUsefulRow);

  if (rows.length === 0) {
    const preview = lines.slice(0, 12).map((line) => lineText(line.items)).filter(Boolean);
    log(`품목을 못 찾았습니다. 읽힌 행 미리보기:\n${preview.join("\n")}`);
  }

  return rows;
}

function rowFromLine(items, columns, pageNumber) {
  const cell = (key) => items
    .filter((item) => item.x >= columns[key].min && item.x < columns[key].max)
    .sort((a, b) => a.x - b.x)
    .map((item) => item.text)
    .join(" ")
    .trim();

  return {
    name: cleanCell(cell("name")),
    spec: cleanCell(cell("spec")),
    quantity: toNumber(cell("quantity")),
    unitPrice: toNumber(cell("unitPrice")),
    page: pageNumber,
  };
}

function rowFromTokens(items, pageNumber) {
  const tokens = items
    .sort((a, b) => a.x - b.x)
    .map((item) => item.text)
    .filter((text) => !isIgnoredToken(text));

  if (tokens.length < 3) {
    return emptyRow(pageNumber);
  }

  const joined = tokens.join(" ");
  if (isHeaderLike(joined)) {
    return emptyRow(pageNumber);
  }

  const priceIndex = findLastIndex(tokens, isPriceLike);
  if (priceIndex < 0) {
    return emptyRow(pageNumber);
  }

  const quantityIndex = findPreviousIndex(tokens, priceIndex - 1, isQuantityLike);
  if (quantityIndex < 0) {
    return emptyRow(pageNumber);
  }

  const specIndex = findPreviousIndex(tokens, quantityIndex - 1, isSpecLike);
  if (specIndex < 0) {
    return emptyRow(pageNumber);
  }

  const nameTokens = tokens
    .slice(0, specIndex)
    .filter((token) => !isRowNumberLike(token));

  return {
    name: cleanCell(nameTokens.join(" ")),
    spec: cleanCell(tokens[specIndex]),
    quantity: toNumber(tokens[quantityIndex]),
    unitPrice: toNumber(tokens[priceIndex]),
    page: pageNumber,
  };
}

function isUsefulRow(row) {
  if (!row.name || row.name.includes("내용")) return false;
  if (row.name.includes("합계") || row.name.includes("소계")) return false;
  return Boolean(row.spec || row.quantity || row.unitPrice);
}

function emptyRow(pageNumber) {
  return {
    name: "",
    spec: "",
    quantity: null,
    unitPrice: null,
    page: pageNumber,
  };
}

function lineText(items) {
  return items
    .sort((a, b) => a.x - b.x)
    .map((item) => `[${Math.round(item.x)},${Math.round(item.y)}]${item.text}`)
    .join(" ");
}

function isHeaderLike(text) {
  return text.includes("내용") ||
    text.includes("규격") ||
    text.includes("수량") ||
    text.includes("예상단가") ||
    text.includes("단가");
}

function isIgnoredToken(text) {
  const normalized = normalizeText(text);
  return normalized === "" ||
    normalized === "N" ||
    normalized === "Y" ||
    normalized === "상태" ||
    normalized === "순번" ||
    normalized === "선택" ||
    normalized === "□" ||
    normalized === "☐";
}

function isRowNumberLike(text) {
  return /^\d{1,3}$/.test(normalizeText(text));
}

function isQuantityLike(text) {
  const value = toNumber(text);
  return Number.isInteger(value) && value > 0 && value < 100000;
}

function isPriceLike(text) {
  const normalized = normalizeText(text);
  const value = toNumber(normalized);
  return Number.isFinite(value) && value >= 10 && (normalized.includes(",") || value >= 100);
}

function isSpecLike(text) {
  const normalized = normalizeText(text).toLowerCase();
  return /\d/.test(normalized) &&
    (/[*x×]/.test(normalized) || /[a-z가-힣]/.test(normalized) || /\d{2,}/.test(normalized));
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function findPreviousIndex(items, startIndex, predicate) {
  for (let index = startIndex; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function groupByLine(items, tolerance) {
  const lines = [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  sorted.forEach((item) => {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
  });

  return lines.map((line) => ({
    ...line,
    items: line.items.sort((a, b) => a.x - b.x),
  }));
}

function renderColumnInputs() {
  els.columnInputs.innerHTML = Object.entries(state.columns).map(([key, column]) => `
    <div class="range-row">
      <label>${column.label}</label>
      <input type="number" data-column="${key}" data-edge="min" value="${Math.round(column.min)}" aria-label="${column.label} 시작 x좌표">
      <input type="number" data-column="${key}" data-edge="max" value="${Math.round(column.max)}" aria-label="${column.label} 끝 x좌표">
    </div>
  `).join("");

  els.columnInputs.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      state.columns[input.dataset.column][input.dataset.edge] = Number(input.value);
    });
  });
}

function renderResults() {
  els.resultTitle.textContent = `품목 ${state.rows.length}개`;
  els.copyJson.disabled = state.rows.length === 0;
  els.downloadCsv.disabled = state.rows.length === 0;

  if (state.rows.length === 0) {
    els.resultBody.innerHTML = `<tr class="empty-row"><td colspan="6">추출된 품목이 없습니다. 컬럼 보정값을 조정해 다시 시도하세요.</td></tr>`;
    return;
  }

  els.resultBody.innerHTML = state.rows.map((row) => `
    <tr>
      <td>${row.no}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${escapeHtml(row.spec)}</td>
      <td>${row.quantity ?? ""}</td>
      <td>${formatNumber(row.unitPrice)}</td>
      <td>${row.page}</td>
    </tr>
  `).join("");
}

function clearResults() {
  state.rows = [];
  state.debug = [];
  els.resultTitle.textContent = "품목 0개";
  els.resultBody.innerHTML = `<tr class="empty-row"><td colspan="6">PDF를 업로드하면 품목이 여기에 표시됩니다.</td></tr>`;
  els.copyJson.disabled = true;
  els.downloadCsv.disabled = true;
  els.debugLog.textContent = "";
  setStatus(state.file ? `${state.file.name} 선택됨.` : "아직 선택된 PDF가 없습니다.");
}

function toCsv(rows) {
  const header = ["순번", "내용", "규격", "수량", "예상단가", "페이지"];
  const body = rows.map((row) => [
    row.no,
    row.name,
    row.spec,
    row.quantity ?? "",
    row.unitPrice ?? "",
    row.page,
  ]);

  return [header, ...body]
    .map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function compactText(text) {
  return normalizeText(text).replace(/\s+/g, "");
}

function cleanCell(text) {
  return normalizeText(text).replace(/^[-ㆍ·\s]+/, "");
}

function toNumber(text) {
  const normalized = normalizeText(text).replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function formatNumber(value) {
  return typeof value === "number" ? value.toLocaleString("ko-KR") : "";
}

function midpoint(a, b) {
  return (a + b) / 2;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function log(message) {
  state.debug.push(message);
  els.debugLog.textContent = state.debug.join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
