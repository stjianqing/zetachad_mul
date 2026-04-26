export function grade(question, userAnswer) {
  if (typeof userAnswer !== 'string') return { correct: false };
  const trimmed = userAnswer.trim();
  if (trimmed === '') return { correct: false };
  // Integer pattern only: optional leading sign, then digits.
  if (!/^[-+]?\d+$/.test(trimmed)) return { correct: false };
  const parsed = Number(trimmed);
  return { correct: parsed === question.answer };
}
