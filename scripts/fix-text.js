'use strict';
const Database = require('better-sqlite3');
const db = new Database('data/portfolio.db');

// Ensure pageTitle column exists
const cols = db.pragma('table_info(projects)').map(c => c.name);
if (!cols.includes('pageTitle')) {
  db.exec(`ALTER TABLE projects ADD COLUMN pageTitle TEXT NOT NULL DEFAULT ''`);
  console.log('+ added pageTitle column');
}

// pageTitle = the longer H1 shown on the project page (differs from the short card title)
// subtitle  = the line shown below the H1 on the project page
const fixes = {
  'computer-workstation': {
    pageTitle: 'Transportable Computer Workstation',
    subtitle:  'Design Thesis Project',
  },
  'head-puzzle': {
    pageTitle: 'Robotic Head Puzzle Box',
    // subtitle already correct: "He Can See You"
  },
  'floating-yoda': {
    pageTitle: 'Levitating Animatronic Grogu',
    subtitle:  'My Dream Desk-Toy',
  },
  'mechanical-jewelry': {
    pageTitle: 'Mechanical and Mechatronic Jewelry',
    subtitle:  'Collection of Engineered Jewelry',
  },
  'medical-devices': {
    pageTitle: 'Sub-Retinal Implantation Instrument Accessories',
    subtitle:  'Process, Packaging, and Surgical Instrument Design',
  },
  'fiskars': {
    pageTitle: 'Fiskars New Product Development',
    subtitle:  'Product Development for Hand Tools',
  },
  'wheelchair-lift': {
    subtitle:  'Lightweight Lift for Sport Wheelchairs',
  },
  'giant-etch-a-sketch': {
    subtitle:  'Interaction Study',
  },
  'traffic-light': {
    subtitle:  'Installation Art Piece',
  },
  'parking-meter': {
    subtitle:  'Installation Art Piece',
  },
};

const sel = db.prepare('SELECT slug, title, subtitle, pageTitle FROM projects WHERE slug = ?');
const upd = db.prepare('UPDATE projects SET subtitle = @subtitle, pageTitle = @pageTitle WHERE slug = @slug');

for (const [slug, patch] of Object.entries(fixes)) {
  const row = sel.get(slug);
  if (!row) { console.log('NOT FOUND:', slug); continue; }

  const newSubtitle  = patch.subtitle  ?? row.subtitle;
  const newPageTitle = patch.pageTitle ?? row.pageTitle;

  upd.run({ slug, subtitle: newSubtitle, pageTitle: newPageTitle });
  console.log(`✓ ${slug}`);
  if (newSubtitle  !== row.subtitle)  console.log(`    subtitle:  "${row.subtitle}" → "${newSubtitle}"`);
  if (newPageTitle !== row.pageTitle) console.log(`    pageTitle: "${row.pageTitle}" → "${newPageTitle}"`);
}

console.log('\nDone.');
