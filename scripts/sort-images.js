'use strict';
// Moves root-level user-downloaded images into the correct slug subdirectories
// and adds any genuinely new images to the database.

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH     = path.join(__dirname, '..', 'data', 'portfolio.db');
const IMAGES_BASE = path.join(__dirname, '..', 'public', 'images', 'projects');

// Each [original-filename, target-slug] pair
// Spaces are preserved here; we replace them with underscores on disk.
const MAPPINGS = [
  // ── golf-ball-picker ──────────────────────────────────────────────────────
  ['68b1bb4473e0c91daf861eaf_IMG_7307.jpg',           'golf-ball-picker'],
  ['68b1bb4cec1541e008977d91_IMG_7301.jpg',           'golf-ball-picker'],
  ['68b1bd981cf4e20a04af0866_IMG_6295-p-2000.jpg',   'golf-ball-picker'],
  ['68b1bd9cf89575df71b2e860_IMG_6297-p-2000.jpg',   'golf-ball-picker'],
  ['68b1bf5bdf3da2ae69d73a5b_IMG_6279-p-2000.jpg',   'golf-ball-picker'],
  ['68b1bf60551924e0c66d242a_IMG_6280-p-2000.jpg',   'golf-ball-picker'],
  ['68b1bf9e3b77e0275ee81081_IMG_7126.jpg',           'golf-ball-picker'],
  ['68b1bfb4d2cbdf906290bb0e_IMG_7137.jpg',           'golf-ball-picker'],
  ['68b1bfd9f268e3d5b02d0505_IMG_7294.png',           'golf-ball-picker'],   // NEW
  ['68b1c13899941a5d0a4c72d7_IMG_7296.png',           'golf-ball-picker'],
  ['68b1c142421e43b9ba1d60df_IMG_7298.png',           'golf-ball-picker'],
  ['68b1c3051cf4e20a04b113d5_IMG_7305.jpg',           'golf-ball-picker'],

  // ── computer-workstation ──────────────────────────────────────────────────
  ['689911eda579022dc228b702_Workstation Hero-p-1600.jpg',       'computer-workstation'],
  ['6899152db0515e8951133cb4_Thumbnail.jpg',                     'computer-workstation'],  // NEW dedicated thumbnail
  ['6899427f493ebb9b8f347f09_Cardboard Prototypes.png',          'computer-workstation'],
  ['689942b25ceaea2df11426d5_Final Prototype-p-2000.jpg',        'computer-workstation'],
  ['689942b2f72bc963bc324bd6_Functional Prototype.png',          'computer-workstation'],
  ['689942ddc1b0875108883e63_TrekTech Thumbnail Closed.png',     'computer-workstation'],
  ['689942f0d6a2e4f32c08681b_TrekTech Thumbnail Open.png',       'computer-workstation'],
  ['689942f4061264cd898f8208_Internals.png',                     'computer-workstation'],
  ['68a0f34b4a479f34ec31acef_IMG_2244.jpg',                      'computer-workstation'],
  ['68a0f34b60dd863f870c6abf_IMG_2599 (1)-p-2000.jpg',           'computer-workstation'],
  ['68a0f34b8c7471a21a2c977d_IMG_2538 (1)-p-2000.jpg',           'computer-workstation'],
  ['68a0f34ba6ee9ec4fd81bace_IMG_2536 (1)-p-2000.jpg',           'computer-workstation'],
  ['68a0f34bda4c4a508761d544_IMG_2600 (1)-p-2000.jpg',           'computer-workstation'],
  ['68a0f34bf8cd8e7b32c75d96_IMG_2539 (1).jpg',                  'computer-workstation'],
  ['68a0f34c2d7833cda888d718_IMG_2248-p-2000.jpg',               'computer-workstation'],
  ['68a0f50cb90e180494673174_IMG_2246 (1)-p-2000.jpg',           'computer-workstation'],
  ['68a0f55fd76c4ad323abb9a7_IMG_2245 (1)-p-2000.jpg',           'computer-workstation'],

  // ── wheelchair-lift ───────────────────────────────────────────────────────
  ['68a1222b1a82e0deead6ae42_levate.png',                                                   'wheelchair-lift'],
  ['68a1222631297cf8657da257_thumb2-p-2000.jpg',                                            'wheelchair-lift'],
  ['68a11c927fc9a0ca07fd0016_ab9a4424-464d-4942-b400-89fa3b3d31f4_rw_600.jpg',             'wheelchair-lift'],
  ['68a120677730d699411a25da_5d569b4c-c148-4d6f-b94f-9705889c86db_rw_600.jpg',             'wheelchair-lift'],
  ['68a120bae6798d83ea786605_CF6E5296-F7DB-4C22-9EFB-FD5542FE6D29 (1)-p-2000.jpg',         'wheelchair-lift'],
  ['68a120bba0924a58f902a411_7B605661-8A6F-45AE-9C46-BE3F3756D268 (1)-p-2000.jpg',         'wheelchair-lift'],
  ['68a120bba0924a58f902a411_7B605661-8A6F-45AE-9C46-BE3F3756D268 (1)-p-2000 (1).jpg',     'wheelchair-lift'],
  ['68a12200189bb8bcda3fb89b_IMG_1573_Original-p-2000.jpg',                                 'wheelchair-lift'],

  // ── medical-devices ───────────────────────────────────────────────────────
  ['689ace5f70997746c0d74953_closep.jpg',                                     'medical-devices'],
  ['689ace9329b962d48904a347_short prototype IMG_2281_Original-p-2000.jpg',   'medical-devices'],
  ['689acebb56181a4de5ee2f0c_IMG_2316_Original.jpg',                          'medical-devices'],
  ['689ad16cbb33876c42ab2094_IMG_2281_Original small.jpg',                    'medical-devices'],
  ['689ad1c3b74bd80b0aaa60d4_IMG_2572_Original-p-2000.jpg',                   'medical-devices'],
  ['689ad1c3ddf8538c00e6e4ec_IMG_0492-p-2000.jpg',                            'medical-devices'],

  // ── fiskars ───────────────────────────────────────────────────────────────
  ['68a0bacca796f4570dbebdd2_Fiskars Thumbnail.png',                          'fiskars'],
  ['68a0d70dff0c8f7c9aa5e84b_fiskars_building_fixing_hero-p-1600.jpg',        'fiskars'],
  ['68a0b7e3813dcfc40af52382_IMG_2371-p-2000.jpg',                            'fiskars'],
  ['68a0b7e2a0924a58f9f5e618_Screenshot 2022-11-01 003526.png',               'fiskars'],
  ['68a0ef0b65f78cc05fc3975c_IMG_2389-p-2000.jpg',                            'fiskars'],
  ['68a0ef0b77af4feb189aa3ca_IMG_2390-p-2000.jpg',                            'fiskars'],
  ['68a0ef0b2d790d5688cad0a4_IMG_0678-p-2000.jpg',                            'fiskars'],
  ['68a0d7cf2bddc5018d7cff92_IMG_0679-p-2000.jpg',                            'fiskars'],
  ['68a0d6efab648ffa92b0ab87_IMG_2289.jpg',                                   'fiskars'],
  ['68a0ba8cff79ea4054c66087_IMG_2291.jpg',                                   'fiskars'],
  ['68a0ba8f23f7f7a201673534_IMG_2290.jpg',                                   'fiskars'],
  ['68a0b8a171e57c9674cdc58d_Screenshot 2022-11-01 003823.png',               'fiskars'],
  ['68a0b8a4e83da224ff30504e_64194376736__F4978AC7-8C03-4F47-9697-FC7C5BBBF251-p-2000.jpg', 'fiskars'],
  ['68a0b9a923f7f7a201672219_IMG_5907-p-2000.jpeg',                           'fiskars'],
  ['68a0b9ad69d0d522d9ed1382_IMG_5908-p-2000.jpeg',                           'fiskars'],

  // ── head-puzzle ───────────────────────────────────────────────────────────
  ['68a0fba39bd5ca0f003a5ab3_IMG_2740-p-1600.jpg',              'head-puzzle'],
  ['68a11a30dafd6cd1069a07f0_IMG_1290.jpg',                     'head-puzzle'],
  ['68a11a4b6927d308afc9a586_HeadAnimation-ezgif.com-optimize.gif', 'head-puzzle'],
  ['68a11a76957f8dd4361b82ca_blinking.gif',                     'head-puzzle'],
  ['68a11a76f8231c1a57935e34_mouthing.gif',                     'head-puzzle'],
  ['68a0f95aa2a187c96b00d2c1_IMG_1530-p-2000.jpg',              'head-puzzle'],
  ['68a113050123c0be15cc57c3_IMG_1341-p-2000.jpg',              'head-puzzle'],
  ['68a112d5fb7309f19923c12a_IMG_1325-p-2000.jpg',              'head-puzzle'],
  ['68a0fb0cdf703dcdcfbc4b18_IMG_2745-p-2000.jpg',              'head-puzzle'],
  ['689ab74e71265d88b73b11e4_IMG_2715-p-2000.jpg',              'head-puzzle'],  // NEW
  ['68a0f786e2a87ece7aa3a59b_IMG_2731-p-2000.jpg',              'head-puzzle'],  // NEW

  // ── floating-yoda ─────────────────────────────────────────────────────────
  ['68a10d3136d34c60b9a4eff9_IMG_0378-ezgif.com-optimize.gif',           'floating-yoda'],
  ['68a10358ae20130ac8deb13c_Yoda Thumbnail-p-2000.png',                 'floating-yoda'],
  ['68a10358ae20130ac8deb13c_Yoda Thumbnail-p-2000 (1).png',             'floating-yoda'],
  ['68a1188230fcfb0d51a08ae9_IMG_0362-p-2000.jpg',                       'floating-yoda'],
  ['68a118826a1468a80ac5a173_IMG_0364-p-2000.jpg',                       'floating-yoda'],
  ['68a11882fe0aceb5dafcccd7_IMG_0366-p-2000.jpg',                       'floating-yoda'],
  ['68a118888b7aea198055bee2_yodaanimation-ezgif.com-video-to-gif-converter.gif', 'floating-yoda'],

  // ── giant-etch-a-sketch ───────────────────────────────────────────────────
  ['6898fdd3abfa9b081372bf2d_thumbnail2.png',                   'giant-etch-a-sketch'],
  ['68996325f856414e819ed754_IMG_7085-p-1600.jpg',              'giant-etch-a-sketch'],
  ['689ac6605ba9773f341329a0_etch open ugly-min (1)-p-2000.png','giant-etch-a-sketch'],
  ['689965d700b8583e9b2a18e8_IMG_3315.png',                     'giant-etch-a-sketch'],
  ['689965d76b0c6d800ae1c07a_IMG_3316.png',                     'giant-etch-a-sketch'],
  ['689966f8f856414e819f63e0_1.png',                            'giant-etch-a-sketch'],
  ['689966f8e607b290606cb35f_2.png',                            'giant-etch-a-sketch'],

  // ── traffic-light ─────────────────────────────────────────────────────────
  ['689acad6febb312100f6fb2e_CroppedVideo-ezgif.com-video-to-gif-converter.gif', 'traffic-light'],
  ['689ac969a78dcb11fd33a44e_IMG_2765-p-2000.jpg',              'traffic-light'],
  ['689ac96eb0aedca2e1ec89c5_IMG_2756-p-1600.jpg',              'traffic-light'],
  ['689ac97280998a5fdbf28a95_IMG_2762-p-2000.jpg',              'traffic-light'],
  ['689acbcc9301b0aaf35cd8b0_Thumbnail-p-2000.jpg',             'traffic-light'],

  // ── parking-meter ─────────────────────────────────────────────────────────
  ['68996d643ba6e73cb2f303b5_IMG_2150-min-min-p-2000.png',      'parking-meter'],
  ['68996cfd6b0c6d800ae2df2a_silhouette-min-p-2000.png',        'parking-meter'],
  ['68996dd3916faa50ee66255a_Video of Working.gif',              'parking-meter'],
  ['68996901c959083bd01f1fb0_Top-p-2000.png',                   'parking-meter'],
  ['68996d10577f877ced1297e7_Detailed View-p-2000.png',         'parking-meter'],

  // ── mechanical-jewelry ────────────────────────────────────────────────────
  ['6899018090a30fcaf2257031_IMG_2672.png',                      'mechanical-jewelry'],  // NEW original
  ['68990a30788bad33dc4b6adc_IMG_2672 - Copy.png',               'mechanical-jewelry'],
  ['6899024a253d5b3266ecb565_moon open 2.jpg',                   'mechanical-jewelry'],
  ['6899058a4b0e3b979f65ea63_moon.jpg',                          'mechanical-jewelry'],
  ['689905e3dbdef9fa4b6aa2e3_4741705091237_.pic_hd-p-2000.jpg', 'mechanical-jewelry'],
  ['689905e5265d27ca0743f6c3_4661705091204_.pic_hd.jpg',         'mechanical-jewelry'],
  ['689906053d6be55f9db3c66f_4701705091220_.pic_hd.jpg',         'mechanical-jewelry'],
  ['6899060556d4ce4dabefbe51_4711705091225_.pic_hd-p-2000.jpg', 'mechanical-jewelry'],
  ['689906e18853e16038bbc3bb_4641705091196_.pic_hd-p-2000.jpg', 'mechanical-jewelry'],
  ['689906e1fddcf74a1fd01f97_4651705091200_.pic_hd.jpg',         'mechanical-jewelry'],
];

// ── Move files ────────────────────────────────────────────────────────────────
let moved = 0, skipped = 0, missing = 0;

for (const [original, slug] of MAPPINGS) {
  const src  = path.join(IMAGES_BASE, original);
  const dest = path.join(IMAGES_BASE, slug, original.replace(/\s+/g, '_'));

  if (!fs.existsSync(src)) { missing++; continue; }

  fs.mkdirSync(path.join(IMAGES_BASE, slug), { recursive: true });

  if (fs.existsSync(dest)) {
    fs.unlinkSync(src);   // remove root copy — slug dir already has it
    skipped++;
  } else {
    fs.renameSync(src, dest);
    console.log(`  → ${slug}/${path.basename(dest)}`);
    moved++;
  }
}

console.log(`\nMoved: ${moved}  |  Skipped (already in slug dir): ${skipped}  |  Not found: ${missing}`);

// ── Report any remaining root-level files ─────────────────────────────────────
const remaining = fs.readdirSync(IMAGES_BASE).filter(f =>
  fs.statSync(path.join(IMAGES_BASE, f)).isFile()
);
if (remaining.length) {
  console.log('\nUnmapped root files (left in place):');
  remaining.forEach(f => console.log('  ?', f));
} else {
  console.log('\nRoot directory is clean — all files are in slug subdirectories.');
}

// ── Add new images to DB sections ─────────────────────────────────────────────
const db = new Database(DB_PATH);

function updateSections(slug, fn) {
  const row = db.prepare('SELECT sections FROM projects WHERE slug = ?').get(slug);
  if (!row) return;
  const sections = JSON.parse(row.sections);
  fn(sections);
  db.prepare('UPDATE projects SET sections = ? WHERE slug = ?')
    .run(JSON.stringify(sections), slug);
}

// golf-ball-picker: add IMG_7294 to the Testing section (index 3)
updateSections('golf-ball-picker', sections => {
  const testing = sections.find(s => s.heading === 'Testing');
  if (testing && !testing.images.some(i => i.src.includes('IMG_7294'))) {
    testing.images.push({
      src: '/images/projects/golf-ball-picker/68b1bfd9f268e3d5b02d0505_IMG_7294.png',
      alt: '',
    });
    console.log('\nDB: added IMG_7294 to golf-ball-picker → Testing');
  }
});

// head-puzzle: add IMG_2715 + IMG_2731 to the Mechanisms section
updateSections('head-puzzle', sections => {
  const mechanisms = sections.find(s => s.heading === 'Mechanisms');
  if (mechanisms) {
    if (!mechanisms.images.some(i => i.src.includes('IMG_2715'))) {
      mechanisms.images.push({
        src: '/images/projects/head-puzzle/689ab74e71265d88b73b11e4_IMG_2715-p-2000.jpg',
        alt: '',
      });
      console.log('DB: added IMG_2715 to head-puzzle → Mechanisms');
    }
    if (!mechanisms.images.some(i => i.src.includes('IMG_2731'))) {
      mechanisms.images.push({
        src: '/images/projects/head-puzzle/68a0f786e2a87ece7aa3a59b_IMG_2731-p-2000.jpg',
        alt: '',
      });
      console.log('DB: added IMG_2731 to head-puzzle → Mechanisms');
    }
  }
});

// mechanical-jewelry: use the original IMG_2672.png as thumbnail (no -Copy)
const mj = db.prepare('SELECT thumbnail FROM projects WHERE slug = ?').get('mechanical-jewelry');
if (mj && mj.thumbnail.includes('Copy')) {
  db.prepare('UPDATE projects SET thumbnail = ?, thumbnailAlt = ? WHERE slug = ?')
    .run('/images/projects/mechanical-jewelry/6899018090a30fcaf2257031_IMG_2672.png', 'Mechanical Jewelry', 'mechanical-jewelry');
  console.log('DB: updated mechanical-jewelry thumbnail to IMG_2672.png');
}

console.log('\n✅  Done.\n');
