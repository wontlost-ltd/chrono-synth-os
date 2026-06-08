/**
 * SetupChecklistContainer — connects useSetupProgress + SetupChecklist.
 *
 * Kept separate from SetupChecklist itself so the latter stays presentational
 * and easy to test in isolation. This container is what AppShell mounts.
 */

import { SetupChecklist } from './SetupChecklist';
import { useSetupProgress } from './useSetupProgress';

export function SetupChecklistContainer() {
  const steps = useSetupProgress();
  return <SetupChecklist steps={steps} />;
}
