export default {
  build: {
    rollupOptions: {
      input: new URL('./index.html', import.meta.url).pathname,
    },
  },
};
