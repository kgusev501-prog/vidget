'use strict';

/**
 * What the update notice says, and whether it says anything at all.
 *
 * Kept apart from electron-updater so the rules can be tested: a skipped
 * version stays quiet until a newer one comes out, a download under way is
 * always shown, and a check the user asked for by hand shows its answer even
 * for a version they once skipped.
 */

function describe(state) {
  const s = state || {};
  switch (s.status) {
    case 'checking':
      return 'проверяем…';
    case 'none':
      return 'установлена последняя версия';
    case 'available':
      return `доступна версия ${s.version}`;
    case 'downloading':
      return `загружаем ${s.version} — ${Math.max(0, Math.min(100, Math.round(s.percent || 0)))} %`;
    case 'ready':
      return `версия ${s.version} загружена`;
    case 'installing':
      return `устанавливаем ${s.version}, виджет перезапустится`;
    case 'error':
      return s.error || 'не удалось проверить';
    default:
      return 'ещё не проверялось';
  }
}

/**
 * Whether the notice in the panel should be shown.
 *
 * @param {object} state        what the updater reports
 * @param {string} skipped      version the user chose to skip, if any
 * @param {boolean} dismissed   closed for this session with its cross
 */
function shouldOffer(state, skipped, dismissed = false) {
  const s = state || {};
  // Once the user has said «обновить», they see it through to the end.
  if (s.status === 'downloading' || s.status === 'ready' || s.status === 'installing') return true;
  // An error only matters to someone who is already updating.
  if (s.status === 'error') return !!s.version && s.userStarted === true;
  if (s.status !== 'available' || !s.version) return false;
  if (s.manual) return true;
  if (dismissed) return false;
  return String(s.version) !== String(skipped || '');
}

module.exports = { describe, shouldOffer };
