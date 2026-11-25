// A tab that names its window and carries instructions for a manual drag.
// The text is test data chosen by the driver; the recorder never stores titles.
const params = new URLSearchParams(location.search);
const title = params.get('title') || 'tab';
document.title = title;
document.getElementById('title').textContent = title;
document.getElementById('text').textContent = params.get('text') || '';
