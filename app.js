const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const state = {
  file: null,
  rows: [],
  debug: [],
};

const els = {
  file: document.querySelector("#pdfFile"),
  dropzone: document.querySelector("#dropzone"),
  extract: document.querySelector("#extractBtn"),
  clear: document.querySelector("#sampleBtn"),
  status: document.querySelector("#status"),
  resultTitle: document.querySelector("#resultTitle"),
  resultBody: document.querySelector("#resultBody"),
  copyJson: document.querySelector("#copyJson"),
  downloadCsv: document.querySelector("#downloadCsv"),
  debugLog: document.querySelector("#debugLog"),
};

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
      const lines = getPageLines(textContent.items);
      const pageRows = parseGmarketByKeywords(lines, pageNumber);

      allRows.push(...pageRows);
      log(`${pageNumber}쪽: 텍스트 행 ${lines.length}개, 키워드 매칭 품목 ${pageRows.length}개`);

      if (pageRows.length === 0) {
        log(`읽힌 행 미리보기:\n${lines.slice(0, 20).join("\n")}`);
      }
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

function getPageLines(items) {
  const textItems = items
    .map((item) => {
      const text = normalizeText(item.str);
      const [, , , , x, y] = item.transform;
      return { text, x, y };
    })
    .filter((item) => item.text);

  const lines = [];
  textItems
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .forEach((item) => {
      let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 4);
      if (!line) {
        line = { y: item.y, items: [] };
        lines.push(line);
      }
      line.items.push(item);
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    });

  return lines
    .map((line) => {
      return line.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(" ")
        .trim();
    })
    .filter(Boolean);
}

function parseGmarketByKeywords(lines, pageNumber) {
  const fullText = lines.join("\n");
  if (!hasKeyword(fullText, "상품명") || !hasKeyword(fullText, "공급가액")) {
    return [];
  }

  const blocks = [];
  let current = createBlock();
  let pendingLabel = null;

  for (const line of lines) {
    if (hasKeyword(line, "상품명") && hasBlockData(current)) {
      blocks.push(current);
      current = createBlock();
      pendingLabel = null;
    }

    const values = extractKeywordValues(line);
    if (Object.keys(values).length > 0) {
      applyKeywordValues(current, values);
      pendingLabel = findTrailingLabel(line);
      continue;
    }

    if (pendingLabel && !isSkippableLine(line)) {
      applyKeywordValues(current, { [pendingLabel]: line });
      pendingLabel = null;
    }
  }

  if (hasBlockData(current)) {
    blocks.push(current);
  }

  const rows = blocks
    .map((block) => blockToRow(block, pageNumber))
    .filter((row) => row.name && row.quantity && row.unitPrice);

  if (rows.length > 0) {
    log("키워드 규칙: 상품명/필수선택/추가구성은 내용으로 합치고, 예상단가는 할인금액 없이 공급가액 ÷ 수량으로 계산했습니다.");
  }

  return rows;
}

function extractKeywordValues(line) {
  const matches = [...line.matchAll(labelRegex())];
  if (matches.length === 0) return {};

  const values = {};
  matches.forEach((match, index) => {
    const label = canonicalLabel(match[0]);
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? line.length;
    const value = cleanValue(line.slice(start, end));

    if (value) {
      values[label] = value;
    } else if (!values[label]) {
      values[label] = "";
    }
  });

  return values;
}

function applyKeywordValues(block, values) {
  if (values.productName) pushUnique(block.contents, values.productName);
  if (values.requiredOption) pushUnique(block.contents, values.requiredOption);
  if (values.addOn) pushUnique(block.contents, values.addOn);

  const quantity = toNumber(values.quantity);
  if (quantity) block.quantity = quantity;

  const supplyAmount = toNumber(values.supplyAmount);
  if (supplyAmount) block.supplyAmount = supplyAmount;
}

function blockToRow(block, pageNumber) {
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
}

function createBlock() {
  return {
    contents: [],
    quantity: null,
    supplyAmount: null,
  };
}

function hasBlockData(block) {
  return block.contents.length > 0 || block.quantity || block.supplyAmount;
}

function findTrailingLabel(line) {
  const matches = [...line.matchAll(labelRegex())];
  if (matches.length === 0) return null;

  const last = matches[matches.length - 1];
  const afterLast = cleanValue(line.slice(last.index + last[0].length));
  return afterLast ? null : canonicalLabel(last[0]);
}

function labelRegex() {
  return /(상품명|필수\s*선택|필수선택|추가\s*구성|추가구성|수량|공급\s*가액|공급가액|할인\s*금액|할인금액)/g;
}

function canonicalLabel(label) {
  const compact = compactText(label);
  if (compact === "상품명") return "productName";
  if (compact === "필수선택") return "requiredOption";
  if (compact === "추가구성") return "addOn";
  if (compact === "수량") return "quantity";
  if (compact === "공급가액") return "supplyAmount";
  return "ignored";
}

function hasKeyword(text, keyword) {
  return compactText(text).includes(compactText(keyword));
}

function isSkippableLine(line) {
  return /할인\s*금액|할인금액|합계|총\s*금액|총금액|판매가|배송비/.test(line);
}

function pushUnique(values, value) {
  const cleaned = cleanGmarketName(value);
  if (cleaned && !values.includes(cleaned)) {
    values.push(cleaned);
  }
}

function cleanGmarketName(text) {
  return cleanValue(text)
    .replace(/^(선택|없음|해당없음|무료|기본)\s*$/g, "")
    .replace(/\s*\/\s*$/g, "");
}

function cleanValue(text) {
  return normalizeText(text)
    .replace(/^[:：|\-\s]+/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim();
}

function renderResults() {
  els.resultTitle.textContent = `품목 ${state.rows.length}개`;
  els.copyJson.disabled = state.rows.length === 0;
  els.downloadCsv.disabled = state.rows.length === 0;

  if (state.rows.length === 0) {
    els.resultBody.innerHTML = `<tr class="empty-row"><td colspan="6">추출된 품목이 없습니다. 추출 로그에서 PDF 텍스트를 확인해 주세요.</td></tr>`;
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

function toNumber(text) {
  const normalized = normalizeText(text).replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function formatNumber(value) {
  return typeof value === "number" ? value.toLocaleString("ko-KR") : "";
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
