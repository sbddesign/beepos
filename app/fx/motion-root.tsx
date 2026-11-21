'use client';

import { useEffect } from 'react';
import { startMotion } from './motion';

/** Starts the moving light. Renders nothing. */
export function MotionRoot() {
  useEffect(() => startMotion(document.documentElement), []);
  return null;
}
