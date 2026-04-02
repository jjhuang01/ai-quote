import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export async function importDocxAsHtml(filePath: string): Promise<string> {
  const result = await mammoth.convertToHtml({ path: filePath });
  return result.value;
}

export function importXlsxWorkbook(filePath: string): string[] {
  const workbook = XLSX.readFile(filePath);
  return workbook.SheetNames;
}
