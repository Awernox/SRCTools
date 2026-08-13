import type { Translate, TranslationKey } from './i18n';
import type { RejectionTemplate } from './types';

const BUILTIN_KEYS: Record<string, string> = {
  'builtin-video-missing': 'videoMissing',
  'builtin-video-private': 'videoPrivate',
  'builtin-video-deleted': 'videoDeleted',
  'builtin-timing-mismatch': 'timingMismatch',
  'builtin-rule-break': 'ruleBreak',
  'builtin-wrong-category': 'wrongCategory',
  'builtin-duplicate': 'duplicate',
  'builtin-cut-video': 'cutVideo',
};

export function displayTemplate(template: RejectionTemplate, t: Translate): RejectionTemplate {
  const key = template.builtin ? BUILTIN_KEYS[template.id] : undefined;
  if (!key) return template;
  return {
    ...template,
    label: t(`settings.templates.builtin.${key}.label` as TranslationKey),
    body: t(`settings.templates.builtin.${key}.body` as TranslationKey),
  };
}
