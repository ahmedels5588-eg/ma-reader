export function summarizeProgress(done: number, failed: number, total: number): string {
  if (total === 0) {
    return "لم يتم اختيار صفحات بعد.";
  }

  const remaining = Math.max(total - done - failed, 0);
  return `تمت معالجة ${done} من ${total}. فشل ${failed}. المتبقي ${remaining}.`;
}
