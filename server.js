const express = require('express');
const path = require('path');
const app = express();

// Serve all static files (index.html, css, js, images, etc.) from the current folder
app.use(express.static(path.join(__dirname, '/')));

// Fallback: send index.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
