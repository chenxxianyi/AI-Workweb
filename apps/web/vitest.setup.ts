import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/** 每个用例后卸载组件，避免多次 render 造成重复元素 */
afterEach(() => {
  cleanup();
});
