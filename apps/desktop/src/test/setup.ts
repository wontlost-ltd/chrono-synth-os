/**
 * Vitest global setup — adds the @testing-library/jest-dom matchers
 * (toBeInTheDocument, toHaveAttribute, etc.) and ensures cleanup runs
 * between tests to avoid DOM leakage.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
