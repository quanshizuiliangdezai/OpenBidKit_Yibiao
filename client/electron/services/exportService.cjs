const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { app, dialog } = require('electron');
const { imageSize } = require('image-size');
const {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} = require('docx');

const MAX_IMAGE_WIDTH = 520;
const NUMBERING_REFERENCE = 'technical-plan-numbering';

function sanitizeFilename(value) {
  return String(value || '标书文档')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '标书文档';
}

function cleanText(value) {
  return String(value || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function textRun(text, options = {}) {
  return new TextRun({
    text: cleanText(text),
    font: '宋体',
    size: options.size || 24,
    bold: options.bold,
    italics: options.italics,
    strike: options.strike,
    color: options.color,
    underline: options.underline ? { type: UnderlineType.SINGLE } : undefined,
  });
}

function lineBreakRun() {
  return new TextRun({ break: 1 });
}

function paragraph(children, options = {}) {
  return new Paragraph({
    children: children?.length ? children : [textRun('')],
    heading: options.heading,
    alignment: options.alignment,
    bullet: options.bullet,
    numbering: options.numbering,
    spacing: { before: options.before || 0, after: options.after ?? 160, line: 360 },
    indent: options.indent,
    border: options.border,
    shading: options.shading,
  });
}

function headingLevel(level) {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  return HeadingLevel.HEADING_4;
}

function imageTypeFromMime(mime) {
  if (!mime) return null;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  return null;
}

function imageTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase().replace('.', '');
  if (ext === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'gif', 'bmp'].includes(ext) ? ext : null;
}

async function loadImage(source, context = {}) {
  const url = String(source || '').trim();
  if (!url) return null;

  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrlMatch) {
    return {
      buffer: Buffer.from(dataUrlMatch[2], 'base64'),
      type: imageTypeFromMime(dataUrlMatch[1]),
    };
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`图片下载失败：${url}`);
    }
    const type = imageTypeFromMime(response.headers.get('content-type')) || imageTypeFromPath(new URL(url).pathname);
    return { buffer: Buffer.from(await response.arrayBuffer()), type };
  }

  const fileUrlPrefix = 'file://';
  const rawPath = url.startsWith(fileUrlPrefix) ? fileURLToPath(url) : url;
  const resolvedPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(context.baseDir || process.cwd(), rawPath);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  return {
    buffer: fs.readFileSync(resolvedPath),
    type: imageTypeFromPath(resolvedPath),
  };
}

async function imageRunFromNode(node, context) {
  const loaded = await loadImage(node.url, context);
  if (!loaded?.buffer || !loaded.type) {
    return textRun(`[图片无法导出：${node.alt || node.url || '未知图片'}]`, { color: 'C83220' });
  }

  const size = imageSize(loaded.buffer);
  const sourceWidth = size.width || MAX_IMAGE_WIDTH;
  const sourceHeight = size.height || Math.round(MAX_IMAGE_WIDTH * 0.62);
  const ratio = Math.min(1, MAX_IMAGE_WIDTH / sourceWidth);
  const width = Math.round(sourceWidth * ratio);
  const height = Math.round(sourceHeight * ratio);

  return new ImageRun({
    type: loaded.type,
    data: loaded.buffer,
    transformation: { width, height },
    altText: {
      title: cleanText(node.alt || '图片'),
      description: cleanText(node.alt || node.url || 'Markdown 图片'),
      name: cleanText(node.alt || 'image'),
    },
  });
}

async function inlineRuns(nodes = [], context = {}, marks = {}) {
  const runs = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(textRun(node.value, marks));
    } else if (node.type === 'strong') {
      runs.push(...await inlineRuns(node.children, context, { ...marks, bold: true }));
    } else if (node.type === 'emphasis') {
      runs.push(...await inlineRuns(node.children, context, { ...marks, italics: true }));
    } else if (node.type === 'delete') {
      runs.push(...await inlineRuns(node.children, context, { ...marks, strike: true }));
    } else if (node.type === 'inlineCode') {
      runs.push(new TextRun({ text: cleanText(node.value), font: 'Consolas', size: 22, color: '155BD7' }));
    } else if (node.type === 'break') {
      runs.push(lineBreakRun());
    } else if (node.type === 'link') {
      const children = await inlineRuns(node.children, context, { ...marks, color: '2174FD', underline: true });
      runs.push(new ExternalHyperlink({ link: node.url, children }));
    } else if (node.type === 'image') {
      runs.push(await imageRunFromNode(node, context));
    } else if (node.children) {
      runs.push(...await inlineRuns(node.children, context, marks));
    }
  }

  return runs;
}

async function tableCellParagraphs(cell, context, isHeader = false) {
  const phrasingNodes = (cell.children || []).filter((child) => child.type !== 'paragraph');
  if (phrasingNodes.length) {
    return [paragraph(await inlineRuns(phrasingNodes, context, { bold: isHeader }), { after: 80 })];
  }

  const blocks = await markdownNodesToDocx(cell.children || [], context, { inTable: true });
  if (!blocks.length) return [paragraph([textRun('')], { after: 80 })];
  return blocks.filter((block) => block instanceof Paragraph);
}

async function markdownNodesToDocx(nodes = [], context = {}, options = {}) {
  const blocks = [];

  for (const node of nodes) {
    if (node.type === 'heading') {
      blocks.push(paragraph(await inlineRuns(node.children, context), {
        heading: headingLevel(node.depth),
        before: node.depth === 1 ? 280 : 180,
        after: 120,
      }));
    } else if (node.type === 'paragraph') {
      blocks.push(paragraph(await inlineRuns(node.children, context), { after: options.inTable ? 80 : 160 }));
    } else if (node.type === 'list') {
      for (const item of node.children || []) {
        const firstParagraph = (item.children || []).find((child) => child.type === 'paragraph');
        const restChildren = (item.children || []).filter((child) => child !== firstParagraph);
        const listOptions = node.ordered
          ? { numbering: { reference: NUMBERING_REFERENCE, level: Math.min(options.listLevel || 0, 2) } }
          : { bullet: { level: Math.min(options.listLevel || 0, 2) } };
        blocks.push(paragraph(await inlineRuns(firstParagraph?.children || [], context), listOptions));
        blocks.push(...await markdownNodesToDocx(restChildren, context, { ...options, listLevel: (options.listLevel || 0) + 1 }));
      }
    } else if (node.type === 'table') {
      const rows = [];
      for (const [rowIndex, row] of (node.children || []).entries()) {
        const cells = [];
        for (const cell of row.children || []) {
          cells.push(new TableCell({
            children: await tableCellParagraphs(cell, context, rowIndex === 0),
            shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: 'F1F6FF' } : undefined,
            margins: { top: 120, bottom: 120, left: 140, right: 140 },
          }));
        }
        rows.push(new TableRow({ children: cells }));
      }
      if (rows.length) {
        blocks.push(new Table({
          rows,
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
            left: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
            right: { style: BorderStyle.SINGLE, size: 1, color: 'DCDFF6' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E8EDF6' },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E8EDF6' },
          },
        }));
      }
    } else if (node.type === 'blockquote') {
      for (const child of node.children || []) {
        if (child.type === 'paragraph') {
          blocks.push(paragraph(await inlineRuns(child.children, context, { color: '536176' }), {
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2174FD' } },
            shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
          }));
        } else {
          blocks.push(...await markdownNodesToDocx([child], context, options));
        }
      }
    } else if (node.type === 'code') {
      blocks.push(paragraph([new TextRun({ text: cleanText(node.value), font: 'Consolas', size: 21, color: '243048' })], {
        shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
        indent: { left: 260, right: 260 },
      }));
    } else if (node.type === 'thematicBreak') {
      blocks.push(paragraph([textRun('────────────────────────', { color: 'DCDFF6' })], { alignment: AlignmentType.CENTER }));
    } else if (node.children) {
      blocks.push(...await markdownNodesToDocx(node.children, context, options));
    }
  }

  return blocks;
}

async function parseMarkdown(content) {
  const [{ unified }, remarkParse, remarkGfm] = await Promise.all([
    import('unified'),
    import('remark-parse'),
    import('remark-gfm'),
  ]);
  return unified().use(remarkParse.default).use(remarkGfm.default).parse(String(content || ''));
}

async function markdownToDocxBlocks(content, context = {}) {
  const tree = await parseMarkdown(content);
  return markdownNodesToDocx(tree.children || [], context);
}

async function addMarkdownContent(children, content, context) {
  children.push(...await markdownToDocxBlocks(content, context));
}

async function addOutlineItems(children, items, context, level = 1) {
  for (const item of items || []) {
    const title = `${item.id || ''} ${item.title || '未命名章节'}`.trim();
    children.push(paragraph([textRun(title, { bold: true })], {
      heading: headingLevel(level),
      before: level === 1 ? 320 : 200,
      after: 120,
    }));

    if (!item.children?.length) {
      if (String(item.content || '').trim()) {
        await addMarkdownContent(children, item.content, context);
      }
      continue;
    }

    await addOutlineItems(children, item.children, context, level + 1);
  }
}

function createNumberingConfig() {
  return {
    config: [{
      reference: NUMBERING_REFERENCE,
      levels: [0, 1, 2].map((level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        style: {
          paragraph: {
            indent: { left: 720 + level * 420, hanging: 260 },
          },
        },
      })),
    }],
  };
}

async function buildDocxBuffer(payload) {
  const context = { baseDir: payload.base_dir || payload.baseDir };
  const children = [
    paragraph([textRun('内容由 AI 生成', { italics: true, size: 18 })], { alignment: AlignmentType.CENTER, after: 120 }),
    paragraph([textRun(payload.project_name || '投标技术文件', { bold: true, size: 34 })], { alignment: AlignmentType.CENTER, after: 300 }),
  ];

  await addOutlineItems(children, payload.outline || [], context);

  const doc = new Document({
    numbering: createNumberingConfig(),
    styles: {
      default: {
        document: {
          run: { font: '宋体', size: 24 },
          paragraph: { spacing: { line: 360, after: 160 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

function createExportService() {
  return {
    async exportWord(payload = {}) {
      if (!Array.isArray(payload.outline) || !payload.outline.length) {
        throw new Error('没有可导出的目录内容');
      }

      const defaultFilename = `${sanitizeFilename(payload.project_name || '标书文档')}.docx`;
      const defaultDir = app?.getPath ? app.getPath('documents') : process.env.USERPROFILE || process.cwd();
      const result = await dialog.showSaveDialog({
        title: '导出 Word 文档',
        defaultPath: path.join(defaultDir, defaultFilename),
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true, message: '已取消导出' };
      }

      fs.writeFileSync(result.filePath, await buildDocxBuffer(payload));
      return { success: true, path: result.filePath, message: 'Word 已导出' };
    },
  };
}

module.exports = {
  buildDocxBuffer,
  createExportService,
};
