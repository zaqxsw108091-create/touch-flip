import { defineConfig } from 'vitest/config';

// base: './' — GitHub Pages 의 서브경로(/touch-flip/)에서도 그대로 동작하도록 상대 경로 사용
export default defineConfig({
  base: './',
  server: {
    host: true, // 같은 Wi-Fi 의 태블릿에서 접속 가능해야 함
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  test: {
    environment: 'node', // GameState / InputGovernor 모두 DOM 없이 테스트된다
    include: ['tests/**/*.test.ts'],
  },
});
