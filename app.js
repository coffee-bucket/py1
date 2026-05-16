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
      const pageRows = parseRows(items, pageColumns, header, pageNumber);

      allRows.push(...pageRows);
      log(
        `${pageNumber}쪽: 텍스트 ${items.length}개, ` +
        `${header ? "헤더 자동 인식" : "수동 컬럼 범위 사용"}, 품목 ${pageRows.length}개`
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

function parseRows(items, columns, header, pageNumber) {
  const tolerance = Number(els.rowTolerance.value) || 4;
  const candidateItems = items.filter((item) => {
    const inTableArea = !header || item.y < header.y - tolerance;
    const inAnyColumn = Object.values(columns).some((column) => item.x >= column.min && item.x < column.max);
    return inTableArea && inAnyColumn;
  });

  return groupByLine(candidateItems, tolerance)
    .map((line) => rowFromLine(line.items, columns, pageNumber))
    .filter(isUsefulRow);
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

function isUsefulRow(row) {
  if (!row.name || row.name.includes("내용")) return false;
  if (row.name.includes("합계") || row.name.includes("소계")) return false;
  return Boolean(row.spec || row.quantity || row.unitPrice);
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
