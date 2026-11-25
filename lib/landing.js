"use strict";
// The landing page on disk has no video section. When the approved videos are
// installed, the section is inserted at the marker before the page is sent.
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "  <!-- film -->\n";
const FILM = path.join(__dirname, "landing-film.html");

async function renderLanding(publicDir, showFilm) {
  const page = await fs.promises.readFile(path.join(publicDir, "landing.html"), "utf8");
  const film = showFilm ? await fs.promises.readFile(FILM, "utf8") : "";
  if (!page.includes(MARKER)) throw new Error("landing.html has no film marker");
  return page.replace(MARKER, () => film);
}

module.exports = { renderLanding, MARKER };
