const app = document.querySelector<HTMLElement>('#app');

if (!app) {
  throw new Error('Playground root element is missing.');
}

app.textContent = 'Vector Studio P0.0 repository foundation';
