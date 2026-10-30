// The standalone B2 harness uses JSX without a lexical React binding. tsx
// reads Next's jsx: preserve setting for component files, so supply the classic
// runtime explicitly without altering application components.
import React from 'react';
globalThis.React = React;
await import('../apps/web/src/components/__tests__/run.tsx');
