// Pure shared schemas: safe to import from host hooks without Node APIs.
export const TASK_KIND = Object.freeze({
  type: 'choice',
  instructions: 'What kind of task is this? Pick the single best fit.',
  criteria: Object.freeze({
    coding: 'writing, editing, debugging or reasoning about code',
    writing: 'prose, docs, content, summaries, review of writing',
    research: 'reading, searching, gathering and synthesizing information',
    general: 'anything else — planning, meta, mixed or unclear',
  }),
});

export const MESSAGE_TOPIC = Object.freeze({
  type: 'choice',
  instructions: '將這則短訊息標記為一個主題；混合、不明確或不符合分類時選 no_match。只標記主題，不決定任何操作。',
  criteria: Object.freeze({
    billing: '帳單、發票、扣款或退款的詢問',
    technical: '軟體功能、錯誤或技術問題的詢問',
    general: '一般產品或服務資訊的詢問',
    no_match: '混合意圖、不明確，或不屬於以上主題',
  }),
});
