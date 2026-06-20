'use strict';
// Downloads all images from lucasiezzi.com Webflow CDN and populates the
// SQLite database with full project content (title, subtitle, sections, images).
// Safe to re-run — overwrites existing DB records.

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH     = path.join(__dirname, '..', 'data', 'portfolio.db');
const IMAGES_BASE = path.join(__dirname, '..', 'public', 'images', 'projects');

// ── CDN helpers ───────────────────────────────────────────────────────────────
const CMS = 'https://cdn.prod.website-files.com/6898c7449015e3306575c8de/';
const c = f => CMS + f;

function localName(url) {
  return decodeURIComponent(url.split('/').pop()).replace(/\s+/g, '_');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    lib.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.destroy();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.destroy();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      file.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ── Project data (scraped from lucasiezzi.com) ────────────────────────────────
const PROJECTS = [
  {
    slug: 'golf-ball-picker',
    title: 'Golf Ball Picker',
    subtitle: 'Pushcart to Pick up Golf Balls',
    thumbnail: c('68b1bb4473e0c91daf861eaf_IMG_7307.jpg'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'A portable pushcart designed for collecting golf balls from practice areas, combining sweeping and collection functions into a single tool with a removable basket.',
        images: [
          c('68b1bb4cec1541e008977d91_IMG_7301.jpg'),
        ],
      },
      {
        heading: 'Research and Brainstorming',
        body: 'Market research on existing solutions, surveys with sales force and golf courses, social listening analysis, followed by team brainstorming exercises and prototype testing iterations.',
        images: [
          c('68b1bd981cf4e20a04af0866_IMG_6295.jpg'),
          c('68b1bd9cf89575df71b2e860_IMG_6297.jpg'),
        ],
      },
      {
        heading: 'Prototyping',
        body: 'First round: low-fidelity MDF and 3D-printed prototypes for concept testing. Second round: near-production quality with metal and off-the-shelf components (looks-like, works-like, built-like).',
        images: [
          c('68b1bf5bdf3da2ae69d73a5b_IMG_6279.jpg'),
          c('68b1bf60551924e0c66d242a_IMG_6280.jpg'),
          c('68b1bfb4d2cbdf906290bb0e_IMG_7137.jpg'),
          c('68b1bf9e3b77e0275ee81081_IMG_7126.jpg'),
        ],
      },
      {
        heading: 'Testing',
        body: 'User testing at each prototype stage with unbiased first-impression feedback, hands-on usage evaluation, comparative ranking exercises, and ideal feature mashup creation.',
        images: [
          c('68b1c13899941a5d0a4c72d7_IMG_7296.PNG'),
          c('68b1c142421e43b9ba1d60df_IMG_7298.PNG'),
        ],
      },
      {
        heading: 'Engineering the Final Result',
        body: 'Design maintained $150 budget constraint using bent sheet metal, bulk-priced wheels, and off-the-shelf components. Features include fold-down funnel, removable basket, ergonomic offset handle, and top carry handle.',
        images: [
          c('68b1c3051cf4e20a04b113d5_IMG_7305.jpg'),
        ],
      },
    ],
  },

  {
    slug: 'computer-workstation',
    title: 'Portable Workstation',
    subtitle: 'Design Thesis Project',
    thumbnail: c('689911eda579022dc228b702_Workstation%20Hero.jpg'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'This project was my thesis for my master\'s degree. I set out to create a product that helps remote workers turn work from home into work from anywhere. Following 10 weeks of research and 10 weeks of prototyping, I developed a portable workstation in a backpack form factor featuring an adjustable monitor, integrated power bank, and USB-C hub.',
        images: [],
      },
      {
        heading: 'Final Result',
        body: 'User research revealed the monitor setup as the primary factor tethering remote workers to their desks. The portable workstation centers on an adjustable, tilting monitor. The integrated battery enables approximately four hours of unplugged work, while the USB hub accommodates peripherals.',
        images: [
          c('689942b25ceaea2df11426d5_Final%20Prototype.jpg'),
          c('689942b2f72bc963bc324bd6_Functional%20Prototype.png'),
        ],
      },
      {
        heading: 'Prototyping',
        body: 'Development progressed from cardboard and foam core mockups to increasingly functional iterations. The final product design comprises a mainboard containing electronics, injection-molded base housing, sheet metal frame for monitor support and adjustability, and fabric casing for storage, straps, and protection.',
        images: [
          c('6899427f493ebb9b8f347f09_Cardboard%20Prototypes.png'),
          c('68a0f34ba6ee9ec4fd81bace_IMG_2536%20(1).jpg'),
          c('68a0f50cb90e180494673174_IMG_2246%20(1).jpg'),
          c('68a0f34b8c7471a21a2c977d_IMG_2538%20(1).jpg'),
          c('68a0f34bda4c4a508761d544_IMG_2600%20(1).jpg'),
          c('68a0f34b4a479f34ec31acef_IMG_2244.jpg'),
          c('68a0f34b60dd863f870c6abf_IMG_2599%20(1).jpg'),
          c('68a0f55fd76c4ad323abb9a7_IMG_2245%20(1).jpg'),
          c('68a0f34bf8cd8e7b32c75d96_IMG_2539%20(1).jpg'),
          c('68a0f34c2d7833cda888d718_IMG_2248.jpg'),
        ],
      },
      {
        heading: 'Sketches',
        body: '',
        images: [
          c('689942f4061264cd898f8208_Internals.png'),
          c('689942ddc1b0875108883e63_TrekTech%20Thumbnail%20Closed.png'),
          c('689942f0d6a2e4f32c08681b_TrekTech%20Thumbnail%20Open.png'),
        ],
      },
    ],
  },

  {
    slug: 'wheelchair-lift',
    title: 'Wheelchair Lift',
    subtitle: 'Lightweight Lift for Sport Wheelchairs',
    thumbnail: c('68a1222b1a82e0deead6ae42_levate.png'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'Takes the MK3 version and addresses mechanical drivetrain issues while incorporating a safety release mechanism for battery failure scenarios. The redesign emphasizes intuitive user interface without requiring visual reference.',
        images: [
          c('68a11c927fc9a0ca07fd0016_ab9a4424-464d-4942-b400-89fa3b3d31f4_rw_600.jpg'),
        ],
      },
      {
        heading: 'Mechanism',
        body: 'Implements a bi-directional one-way clutch to enable raising/lowering while preventing back-driving loads. Includes a lever cam-locking mechanism for single-handed operation from beneath the chair.',
        images: [
          c('68a120bba0924a58f902a411_7B605661-8A6F-45AE-9C46-BE3F3756D268%20(1).jpg'),
          c('68a120bae6798d83ea786605_CF6E5296-F7DB-4C22-9EFB-FD5542FE6D29%20(1).jpg'),
        ],
      },
      {
        heading: 'Prototyping',
        body: 'Design work completed in SolidWorks with FEA analysis. Physical prototypes created via 3D printing combined with off-the-shelf metal parts. Final components machined for validation.',
        images: [
          c('68a120677730d699411a25da_5d569b4c-c148-4d6f-b94f-9705889c86db_rw_600.jpg'),
          c('68a12200189bb8bcda3fb89b_IMG_1573_Original.jpg'),
        ],
      },
    ],
  },

  {
    slug: 'medical-devices',
    title: 'Surgical Devices',
    subtitle: 'Sub-Retinal Implantation Instrument Accessories',
    thumbnail: c('689ace9329b962d48904a347_short%20prototype%20IMG_2281_Original.jpg'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'Collaborated with Mayo Clinic researchers on retinal repair surgery involving scaffold and stem cell implantation, designing bulk cell growth processes, surgical instruments, implant loading mechanisms, and sterile packaging.',
        images: [
          c('689ace5f70997746c0d74953_closep.jpg'),
          c('689acebb56181a4de5ee2f0c_IMG_2316_Original.jpg'),
        ],
      },
      {
        heading: 'Packaging',
        body: 'Sterile, injection-moldable package designed for sub-retinal implants in nutrient solution, enabling aseptic surgeon handling without direct contact and forming the basis for patent and publication work.',
        images: [
          c('689ad16cbb33876c42ab2094_IMG_2281_Original%20small.jpg'),
        ],
      },
      {
        heading: 'Wound Sealing',
        body: 'Two plug designs prevent fluid leakage from large surgical incisions, attaching to instrument shafts to maintain intraocular pressure during eye procedures.',
        images: [
          c('689ad1c3b74bd80b0aaa60d4_IMG_2572_Original.jpg'),
        ],
      },
      {
        heading: 'Cell Growth Fixtures',
        body: 'Dual-design sectioning device isolates scaffold regions with waterproof seals — one compatible with standard 6-well plates, another using a custom-designed plate for increased testing efficiency per scaffold sheet.',
        images: [
          c('689ad1c3ddf8538c00e6e4ec_IMG_0492.jpg'),
        ],
      },
    ],
  },

  {
    slug: 'fiskars',
    title: 'Hand Tool Products',
    subtitle: 'Product Development for Hand Tools',
    thumbnail: c('68a0d70dff0c8f7c9aa5e84b_fiskars_building_fixing_hero.jpg'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'This co-op at Fiskars was my first introduction to consumer product development. I contributed to work on several projects from concepting and prototyping for a new plier product line to testing, validating, and refining utility knives and hand saws in the pre-production tooling sample phase.',
        images: [],
      },
      {
        heading: 'Design and Prototyping',
        body: 'Involved brainstorming sessions with industrial design, developing concepts around user needs identified in research, and building prototypes from loose initial ideas.',
        images: [
          c('68a0b7e3813dcfc40af52382_IMG_2371.jpg'),
          c('68a0b7e2a0924a58f9f5e618_Screenshot%202022-11-01%20003526.png'),
        ],
      },
      {
        heading: 'Testing and Validating',
        body: 'Communicated with overseas partners to coordinate sample testing, analyzed results, led team discussions, and built custom jigs to measure product functional attributes.',
        images: [
          c('68a0ef0b65f78cc05fc3975c_IMG_2389.jpg'),
          c('68a0ef0b77af4feb189aa3ca_IMG_2390.jpg'),
          c('68a0ef0b2d790d5688cad0a4_IMG_0678.JPG'),
          c('68a0d7cf2bddc5018d7cff92_IMG_0679.JPG'),
          c('68a0d6efab648ffa92b0ab87_IMG_2289.jpg'),
          c('68a0ba8cff79ea4054c66087_IMG_2291.jpg'),
          c('68a0ba8f23f7f7a201673534_IMG_2290.jpg'),
        ],
      },
      {
        heading: 'Process Improvement',
        body: 'Operating 3D printers during the pandemic; designed a shop vac scraper attachment to streamline print bed cleaning using surface modeling techniques.',
        images: [
          c('68a0b8a171e57c9674cdc58d_Screenshot%202022-11-01%20003823.png'),
          c('68a0b8a4e83da224ff30504e_64194376736__F4978AC7-8C03-4F47-9697-FC7C5BBBF251.jpg'),
          c('68a0b9a923f7f7a201672219_IMG_5907.JPEG'),
          c('68a0b9ad69d0d522d9ed1382_IMG_5908.JPEG'),
        ],
      },
    ],
  },

  {
    slug: 'head-puzzle',
    title: 'Robotic Head',
    subtitle: 'He Can See You',
    thumbnail: c('68a0fba39bd5ca0f003a5ab3_IMG_2740.jpg'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'Sequential puzzle combining animatronics and robotics with a human head featuring a mobile mouth, blinking eyelids, and gaze-tracking capabilities.',
        images: [
          c('68a11a30dafd6cd1069a07f0_IMG_1290.jpg'),
        ],
      },
      {
        heading: 'Mechanisms',
        body: 'Physical linkages operate eyelids, eyeballs, and mouth via servos. Integrated camera in the eye. Buttons embedded in ears and nostrils. Solenoid-triggered key release mechanism.',
        images: [
          c('68a11a4b6927d308afc9a586_HeadAnimation-ezgif.com-optimize.gif'),
          c('68a11a76957f8dd4361b82ca_blinking.gif'),
          c('68a11a76f8231c1a57935e34_mouthing.gif'),
          c('68a0f95aa2a187c96b00d2c1_IMG_1530.jpg'),
        ],
      },
      {
        heading: 'Electronics',
        body: 'Jetson Nano running ROS handles sequencing. Camera feeds video. Servo driver controlled by MetroMini microcontroller. Speaker provides synchronized audio. Thermal management via fans.',
        images: [
          c('68a113050123c0be15cc57c3_IMG_1341.jpg'),
          c('68a112d5fb7309f19923c12a_IMG_1325.jpg'),
        ],
      },
      {
        heading: 'Software',
        body: 'Python-based control in ROS container managing puzzle phases via nodes handling buttons, image recognition, speech output, servo control, and eye tracking.',
        images: [
          c('68a0fb0cdf703dcdcfbc4b18_IMG_2745.jpg'),
        ],
      },
    ],
  },

  {
    slug: 'floating-yoda',
    title: 'Levitating Grogu',
    subtitle: 'My Dream Desk-Toy',
    thumbnail: c('68a10d3136d34c60b9a4eff9_IMG_0378-ezgif.com-optimize.gif'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'A desk toy created during a 10-week master\'s program orientation sprint responding to a "Stranger Than Fiction" prompt. I built a levitating animatronic Baby Yoda model to develop mechatronics and mechanism skills.',
        images: [
          c('68a1188230fcfb0d51a08ae9_IMG_0362.jpg'),
          c('68a118826a1468a80ac5a173_IMG_0364.jpg'),
          c('68a11882fe0aceb5dafcccd7_IMG_0366.jpg'),
        ],
      },
      {
        heading: 'Technical Details',
        body: 'Combines a commercial levitation module with a custom animatronic design. An STL file was modified in SolidWorks to integrate servo-controlled head rotation and eye-blinking mechanisms. A microcontroller in the base (powered by LiPo battery) operates two servos with randomized motion patterns for realistic movement.',
        images: [
          c('68a118888b7aea198055bee2_yodaanimation-ezgif.com-video-to-gif-converter.gif'),
        ],
      },
    ],
  },

  {
    slug: 'giant-etch-a-sketch',
    title: 'Giant Etch-A-Sketch',
    subtitle: 'Interaction Study',
    thumbnail: c('68996325f856414e819ed754_IMG_7085.JPG'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'Coffee table-sized Etch A Sketch examining how physical interactions transform with scale, featuring a CNC gantry and magnetized marble mechanism.',
        images: [
          c('6898fdd3abfa9b081372bf2d_thumbnail2.png'),
          c('689ac6605ba9773f341329a0_etch%20open%20ugly-min%20(1).png'),
        ],
      },
      {
        heading: 'Design',
        body: 'Multiple integrated components including the CNC gantry, input knobs, clearing system, and plywood housing.',
        images: [
          c('689965d700b8583e9b2a18e8_IMG_3315.png'),
          c('689965d76b0c6d800ae1c07a_IMG_3316.png'),
        ],
      },
      {
        heading: 'Mechanisms',
        body: 'Arduino-based control system with G-Code commands, encoder-based knob input processing, and accelerometer-triggered brush clearing mechanism.',
        images: [
          c('689966f8f856414e819f63e0_1.png'),
          c('689966f8e607b290606cb35f_2.png'),
        ],
      },
    ],
  },

  {
    slug: 'traffic-light',
    title: 'Traffic Light',
    subtitle: 'Installation Art Piece',
    thumbnail: c('689acad6febb312100f6fb2e_CroppedVideo-ezgif.com-video-to-gif-converter.gif'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'A miniature world inside a standard traffic light. Each bulb houses a distinct civilization that reacts differently to the light\'s changing states. The work demonstrates modeling, prototyping, and basic electronics skills.',
        images: [
          c('689ac969a78dcb11fd33a44e_IMG_2765.jpg'),
          c('689ac96eb0aedca2e1ec89c5_IMG_2756.jpg'),
          c('689ac97280998a5fdbf28a95_IMG_2762.jpg'),
        ],
      },
      {
        heading: 'Design',
        body: 'The exterior was modeled in SolidWorks and 3D printed in six components. Toy army figures were modified and painted to represent inhabitants. Clear Christmas ornaments form the light domes. LEDs connect to a microcontroller programmed for standard traffic sequences.',
        images: [],
      },
    ],
  },

  {
    slug: 'parking-meter',
    title: 'Parking Meter',
    subtitle: 'Installation Art Piece',
    thumbnail: c('68996d643ba6e73cb2f303b5_IMG_2150-min-min.png'),
    sections: [
      {
        heading: 'Project Overview',
        body: 'I made this installation sculpture of a parking meter designed to bring awareness to the sale of Chicago\'s street parking spaces to a privatized company. The piece activates when coins are inserted, triggering interior lights representing corporate office spaces benefiting from monetized public parking.',
        images: [
          c('68996cfd6b0c6d800ae2df2a_silhouette-min.png'),
          c('68996dd3916faa50ee66255a_Video%20of%20Working.gif'),
        ],
      },
      {
        heading: 'Design',
        body: 'The artist modeled the meter in SolidWorks and 3D-printed the body. Heat-formed acrylic panels serve as windows. The interior features hand-painted 3D-printed office elements. Internal cavities house coin-detection electronics and LED triggering mechanisms.',
        images: [
          c('68996901c959083bd01f1fb0_Top.png'),
          c('68996d10577f877ced1297e7_Detailed%20View.png'),
        ],
      },
    ],
  },

  {
    slug: 'mechanical-jewelry',
    title: 'Mechanical Jewelry',
    subtitle: 'Collection of Engineered Jewelry',
    thumbnail: c('68990a30788bad33dc4b6adc_IMG_2672%20-%20Copy.png'),
    sections: [
      {
        heading: 'Moon Pendant',
        body: 'Artistic creation featuring wax-carved sterling silver components with garnet stone eyes, dual LEDs activated by magnetic proximity, and moveable eyelids operated via chain manipulation.',
        images: [
          c('6899024a253d5b3266ecb565_moon%20open%202.jpg'),
          c('6899058a4b0e3b979f65ea63_moon.jpg'),
        ],
      },
      {
        heading: 'Ring Lighter',
        body: 'Functional lighter integrated into a signet-style ring. Designed via SolidWorks, soldered silver construction, refillable through removable striker assembly.',
        images: [
          c('689905e3dbdef9fa4b6aa2e3_4741705091237_.pic_hd.jpg'),
          c('689905e5265d27ca0743f6c3_4661705091204_.pic_hd.jpg'),
        ],
      },
      {
        heading: 'Handcuff Ring',
        body: 'SolidWorks-designed piece employing SLA 3D resin printing, lost-wax casting technique, sterling silver construction, internal steel spring mechanism with tension-adjusting screw.',
        images: [
          c('689906053d6be55f9db3c66f_4701705091220_.pic_hd.jpg'),
          c('6899060556d4ce4dabefbe51_4711705091225_.pic_hd.jpg'),
        ],
      },
      {
        heading: 'Pinky Promise Ring',
        body: 'Stone-setting challenge featuring interlocking miniature hands as prong components. Hand-carved brass construction using rotary tools.',
        images: [
          c('689906e18853e16038bbc3bb_4641705091196_.pic_hd.jpg'),
          c('689906e1fddcf74a1fd01f97_4651705091200_.pic_hd.jpg'),
        ],
      },
    ],
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const db = new Database(DB_PATH);
  const upsert = db.prepare(`
    INSERT INTO projects (slug, title, subtitle, thumbnail, thumbnailAlt, sort_order, sections)
    VALUES (@slug, @title, @subtitle, @thumbnail, @thumbnailAlt, @sort_order, @sections)
    ON CONFLICT(slug) DO UPDATE SET
      title        = excluded.title,
      subtitle     = excluded.subtitle,
      thumbnail    = excluded.thumbnail,
      thumbnailAlt = excluded.thumbnailAlt,
      sections     = excluded.sections
  `);

  for (let i = 0; i < PROJECTS.length; i++) {
    const p = PROJECTS[i];
    const dir = path.join(IMAGES_BASE, p.slug);
    fs.mkdirSync(dir, { recursive: true });

    console.log(`\n[${i + 1}/${PROJECTS.length}] ${p.title}`);

    // Download thumbnail
    let thumbLocal = '';
    if (p.thumbnail) {
      const fname = localName(p.thumbnail);
      const dest  = path.join(dir, fname);
      if (fs.existsSync(dest)) {
        console.log(`  thumb  ✓ (cached) ${fname}`);
      } else {
        process.stdout.write(`  thumb    ${fname} … `);
        try {
          await download(p.thumbnail, dest);
          console.log('✓');
        } catch (e) {
          console.log(`✗ ${e.message}`);
        }
      }
      thumbLocal = `/images/projects/${p.slug}/${fname}`;
    }

    // Download section images
    const sections = [];
    for (const sec of p.sections) {
      const localImages = [];
      for (const url of sec.images) {
        const fname = localName(url);
        const dest  = path.join(dir, fname);
        if (fs.existsSync(dest)) {
          process.stdout.write(`  img    ✓ (cached) ${fname}\n`);
        } else {
          process.stdout.write(`  img    ${fname} … `);
          try {
            await download(url, dest);
            console.log('✓');
          } catch (e) {
            console.log(`✗ ${e.message}`);
            continue;
          }
        }
        localImages.push({ src: `/images/projects/${p.slug}/${fname}`, alt: '' });
      }
      sections.push({
        id:      crypto.randomUUID(),
        heading: sec.heading,
        body:    sec.body,
        images:  localImages,
      });
    }

    upsert.run({
      slug:         p.slug,
      title:        p.title,
      subtitle:     p.subtitle,
      thumbnail:    thumbLocal,
      thumbnailAlt: p.title,
      sort_order:   i,
      sections:     JSON.stringify(sections),
    });

    console.log(`  → saved to DB`);
  }

  console.log('\n✅  Done. All projects imported.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
