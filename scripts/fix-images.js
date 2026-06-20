'use strict';
const Database = require('better-sqlite3');
const db = new Database('data/portfolio.db');

function img(slug, filename, alt) {
  return { src: `/images/projects/${slug}/${filename}`, alt: alt || '' };
}

// Each entry: { slug, sections: [{ heading, images: [...] }] }
// Only sections whose images need to change are listed — headings must match exactly.
const fixes = [
  {
    slug: 'golf-ball-picker',
    sections: {
      'Project Overview': [
        img('golf-ball-picker', '68b1bb4473e0c91daf861eaf_IMG_7307.jpg'),
        img('golf-ball-picker', '68b1bb4cec1541e008977d91_IMG_7301.jpg'),
      ],
      'Testing': [
        // Remove IMG_7294 (homepage thumbnail — not a section image)
        img('golf-ball-picker', '68b1c13899941a5d0a4c72d7_IMG_7296.PNG'),
        img('golf-ball-picker', '68b1c142421e43b9ba1d60df_IMG_7298.PNG'),
      ],
      'Engineering the Final Result': [
        img('golf-ball-picker', '68b1bb4cec1541e008977d91_IMG_7301.jpg'),
        img('golf-ball-picker', '68b1c3051cf4e20a04b113d5_IMG_7305.jpg'),
        img('golf-ball-picker', '68b1bb4473e0c91daf861eaf_IMG_7307.jpg'),
      ],
    },
  },
  {
    slug: 'computer-workstation',
    sections: {
      'Project Overview': [
        img('computer-workstation', '689911eda579022dc228b702_Workstation_Hero.jpg'),
      ],
      'Prototyping': [
        img('computer-workstation', '6899427f493ebb9b8f347f09_Cardboard_Prototypes.png'),
      ],
      'Sketches': [
        // Move all 9 sketch photos here from Prototyping, keep the 3 existing ones
        img('computer-workstation', '68a0f34ba6ee9ec4fd81bace_IMG_2536_(1).jpg'),
        img('computer-workstation', '68a0f50cb90e180494673174_IMG_2246_(1).jpg'),
        img('computer-workstation', '68a0f34b8c7471a21a2c977d_IMG_2538_(1).jpg'),
        img('computer-workstation', '68a0f34bda4c4a508761d544_IMG_2600_(1).jpg'),
        img('computer-workstation', '68a0f34b4a479f34ec31acef_IMG_2244.jpg'),
        img('computer-workstation', '68a0f34b60dd863f870c6abf_IMG_2599_(1).jpg'),
        img('computer-workstation', '68a0f55fd76c4ad323abb9a7_IMG_2245_(1).jpg'),
        img('computer-workstation', '68a0f34bf8cd8e7b32c75d96_IMG_2539_(1).jpg'),
        img('computer-workstation', '68a0f34c2d7833cda888d718_IMG_2248.jpg'),
        img('computer-workstation', '689942f4061264cd898f8208_Internals.png'),
        img('computer-workstation', '689942ddc1b0875108883e63_TrekTech_Thumbnail_Closed.png'),
        img('computer-workstation', '689942f0d6a2e4f32c08681b_TrekTech_Thumbnail_Open.png'),
      ],
    },
  },
  {
    slug: 'wheelchair-lift',
    sections: {
      'Project Overview': [],
      'Mechanism': [
        img('wheelchair-lift', '68a1222b1a82e0deead6ae42_levate.png'),
        img('wheelchair-lift', '68a11c927fc9a0ca07fd0016_ab9a4424-464d-4942-b400-89fa3b3d31f4_rw_600.jpg'),
        img('wheelchair-lift', '68a120bba0924a58f902a411_7B605661-8A6F-45AE-9C46-BE3F3756D268_(1).jpg'),
        img('wheelchair-lift', '68a120bae6798d83ea786605_CF6E5296-F7DB-4C22-9EFB-FD5542FE6D29_(1).jpg'),
      ],
    },
  },
  {
    slug: 'head-puzzle',
    sections: {
      'Project Overview': [
        img('head-puzzle', '68a0fba39bd5ca0f003a5ab3_IMG_2740.jpg'),
      ],
      'Mechanisms': [
        img('head-puzzle', '68a11a30dafd6cd1069a07f0_IMG_1290.jpg'),
        img('head-puzzle', '68a11a4b6927d308afc9a586_HeadAnimation-ezgif.com-optimize.gif'),
      ],
      'Electronics': [
        img('head-puzzle', '68a11a76957f8dd4361b82ca_blinking.gif'),
        img('head-puzzle', '68a11a76f8231c1a57935e34_mouthing.gif'),
        img('head-puzzle', '68a0f95aa2a187c96b00d2c1_IMG_1530.jpg'),
        img('head-puzzle', '68a113050123c0be15cc57c3_IMG_1341.jpg'),
      ],
      'Software': [
        img('head-puzzle', '68a112d5fb7309f19923c12a_IMG_1325.jpg'),
        img('head-puzzle', '68a0fb0cdf703dcdcfbc4b18_IMG_2745.jpg'),
      ],
    },
  },
  {
    slug: 'fiskars',
    sections: {
      'Project Overview': [
        img('fiskars', '68a0d70dff0c8f7c9aa5e84b_fiskars_building_fixing_hero.jpg'),
      ],
      'Design and Prototyping': [
        img('fiskars', '68a0b7e3813dcfc40af52382_IMG_2371.jpg'),
        img('fiskars', '68a0b7e2a0924a58f9f5e618_Screenshot_2022-11-01_003526.png'),
        img('fiskars', '68a0ef0b65f78cc05fc3975c_IMG_2389.jpg'),
        img('fiskars', '68a0ef0b77af4feb189aa3ca_IMG_2390.jpg'),
        img('fiskars', '68a0ef0b2d790d5688cad0a4_IMG_0678.JPG'),
        img('fiskars', '68a0d7cf2bddc5018d7cff92_IMG_0679.JPG'),
        img('fiskars', '68a0d6efab648ffa92b0ab87_IMG_2289.jpg'),
        img('fiskars', '68a0ba8cff79ea4054c66087_IMG_2291.jpg'),
        img('fiskars', '68a0ba8f23f7f7a201673534_IMG_2290.jpg'),
      ],
      'Testing and Validating': [
        img('fiskars', '68a0b8a171e57c9674cdc58d_Screenshot_2022-11-01_003823.png'),
        img('fiskars', '68a0b8a4e83da224ff30504e_64194376736__F4978AC7-8C03-4F47-9697-FC7C5BBBF251.jpg'),
      ],
      'Process Improvement': [
        img('fiskars', '68a0b9a923f7f7a201672219_IMG_5907.JPEG'),
        img('fiskars', '68a0b9ad69d0d522d9ed1382_IMG_5908.JPEG'),
      ],
    },
  },
  {
    slug: 'traffic-light',
    sections: {
      'Project Overview': [],
      'Design': [
        img('traffic-light', '689ac969a78dcb11fd33a44e_IMG_2765.jpg'),
        img('traffic-light', '689ac96eb0aedca2e1ec89c5_IMG_2756.jpg'),
        img('traffic-light', '689ac97280998a5fdbf28a95_IMG_2762.jpg'),
      ],
    },
  },
];

const sel = db.prepare('SELECT sections FROM projects WHERE slug = ?');
const upd = db.prepare('UPDATE projects SET sections = ? WHERE slug = ?');

for (const { slug, sections: newImages } of fixes) {
  const row = sel.get(slug);
  if (!row) { console.log('NOT FOUND', slug); continue; }

  const sections = JSON.parse(row.sections);
  let changed = 0;
  for (const sec of sections) {
    if (sec.heading in newImages) {
      sec.images = newImages[sec.heading];
      changed++;
    }
  }
  upd.run(JSON.stringify(sections), slug);
  console.log(`✓ ${slug}: updated ${changed} section(s)`);
}

console.log('\nVerifying all image files exist on disk...');
const fs = require('fs');
const path = require('path');
const allRows = db.prepare('SELECT slug, sections FROM projects ORDER BY sort_order').all();
let missing = 0, ok = 0;
for (const r of allRows) {
  for (const sec of JSON.parse(r.sections)) {
    for (const im of (sec.images || [])) {
      const p = path.join('public', im.src.replace(/^\//, ''));
      if (fs.existsSync(p)) { ok++; }
      else { console.log('  MISSING', r.slug, im.src); missing++; }
    }
  }
}
console.log(`${ok} present, ${missing} missing`);
