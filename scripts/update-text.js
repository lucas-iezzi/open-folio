'use strict';
const Database = require('better-sqlite3');
const db = new Database('data/portfolio.db');

const text = {
  'golf-ball-picker': {
    'Project Overview': 'This product is the first that I have brought entirely from concept to production. It is a portable pushcart golf ball picker designed to allow golf courses and players to quickly pick up golf balls in a practice putting and chipping area. The traditional method involved using a large plastic broom and a tube to pick up one ball at a time. This product combines these functions in one allowing users to sweep across a wide area and collect the balls in a basket that can be removed to carry.',
    'Research and Brainstorming': 'I started by doing a lot of research on existing products that solve the issue of picking up balls in the golf industry as well as in the tennis industry. I created surveys distributed to sales personnel and golf courses, and conducted social listening research by watching videos created by golf course employees. Following research, I lead the team through several brainstorming exercises. The refined concepts were then made so we could test with users. I lead us through this process twice as we converged on a refined set of features for the final product.',
    'Prototyping': 'The focus of my first round of prototypes was to test a wide range of concepts for how balls could be picked up. These prototypes were all lower fidelity made from MDF and 3D printed parts, but critically they were all made to the same fidelity so none stood out purely due to its build quality. The second round of prototypes were near production quality and construction. The parts were all metal and off the shelf parts similar to what we would source for the final product.',
    'Testing': 'I started by showing the user the selection of prototypes that they would test that day and I asked them for their first impressions. I then had them test each prototype by dumping balls onto the green and having them pick it up. I then asked them to rank each prototype based on criteria like, speed of picking, gentileness on the green, etc. Finally, I had them create their ideal product mashup using the features they had just been comparing from each product.',
    'Engineering the Final Result': 'The main constraint I had on this project was keeping the budget below $150. The final design uses all bent sheet metal parts which are easy for nearly any metal manufacturer to produce. Key features include the fold down funnel which funnels balls into the pickup wheel and folds up nicely for storage. The basket that hooks on the back is a part that we distribute in bulk to diving ranges, so it is something they are familiar with using and most likely they have extras laying around.',
  },
  'computer-workstation': {
    'Project Overview': 'This project was my thesis for my master\'s degree. I set out to create a product that helps remote workers turn work from home into work from anywhere. I did this by transforming a traditional desk setup into a portable digital workstation housed in a backpack. The journey began with 10 weeks of design research to outline the problem, followed by 10 weeks of ideation and rapid prototype iteration. The final result was a looks-like and works-like prototype of a final product containing an adjustable monitor, integrated power bank, and USB-C hub inside a travel-sized backpack.',
    'Final Result': 'Based on my user research I identified that for many remote workers, their screen setup is the biggest thing keeping them tied to their desks. Because of this I centered the design of my portable workstation around the monitor which can raise and lower as well as tilt to achieve optimal viewing. The contained batteries allow the user to work unconnected from power for around 4 hours at a time, and the USB hub allows for all of their peripherals to be attached. The laptop can either be used as a second monitor, or stowed in the rear pouch for a compact layout.',
    'Prototyping': 'I started prototyping with rough cardboard and foam core mockups to get initial feedback from people on form factors. As the design evolved, I continued to add more and more functional features until I ended up with my final working prototype. In its final form this product would consist of a mainboard which contains all of the electronics, an injection molded housing for the base of the devices, a sheet metal frame to support the monitor and allow for adjustability, and a fabric outer casing to provide storage and carrying straps as well as impact protection.',
    'Sketches': '',
  },
  'wheelchair-lift': {
    'Project Overview': 'This project was my assignment while working at Hinchey Design Co. My responsibility was to take the MK3 version of the lift and fix the major mechanical issues in the drive train while adding a safety release mechanism for the case of a battery failure when raised. I redesigned the front face of the lift so that it was clear to the user where each key function should be performed without looking.',
    'Mechanism': 'I implemented a bi-directional one-way clutch as the core mechanism. This allows the lift to raise and lower using the motor while transferring back-driving loads to the frame instead of the gearbox. This allows users to raise their chairs and do things while raised without draining battery holding motor position. The mechanism functions similarly to the chuck mechanism in cordless drills. I also created a lever cam-locking mechanism to allow users to lock and unlock the lift from the bottom of their chair using one hand between their legs.',
    'Prototyping': 'I primarily did design work in SolidWorks with multiple iterations and FEA analysis. Some components, especially inside the new clutch I designed, needed to be physically prototyped to ensure they functioned correctly. Prototypes utilized 3D printing with off-the-shelf metal components. Final parts were then machined to validate the solution before production.',
  },
  'medical-devices': {
    'Project Overview': 'During summers and winter breaks, I worked with a research group at the Mayo Clinic who was developing a new surgery in which they implanted a scaffold with STEM cells to repair holes in the retina. I was hired onto this team to support their development by creating designs and physical prototypes for processes to grow their cells on the scaffold in bulk, instrument geometries to prevent large surgical wounds from leaking fluids, methods for loading the scaffold into the implantation device, and packaging to safely store the instrument and keep the STEM cells alive.',
    'Packaging': 'At Mayo Clinic, I designed a sterile, injection-moldable package for sub-retinal implants immersed in nutrient solution. The packaging allows aseptic handling, featuring iterations that refined the user interface for surgeons to handle the implant without direct contact. The design formed the basis for patent and publication work, highlighting its research and practical impact.',
    'Wound Sealing': 'When doing eye surgery to implant or remove large objects, large incisions need to be made. The fluid inside of the eye leaks out of these incisions and requires a lot of fluid to be flowed back into the eye to maintain its pressure. I designed two different plugs that can be attached to the shaft of the surgical instrument to plug the incision and maintain the intraocular pressure.',
    'Cell Growth Fixtures': 'In order to do several tests on a single piece of the implant scaffold material, I was asked to make a fixture that sectioned off small regions of the scaffold sheet with a watertight seal. I made two versions of this device, one for use in a standard 6 well plate which was their existing production method (as seen on the left) and one using a whole new plate that I designed to get more tests out of a single sheet (as seen on the right). This proved difficult because there was a fine balance between enough pressure to create a waterproof seal and not too much that it destroys the fibrin scaffold.',
  },
  'fiskars': {
    'Project Overview': 'This co-op at Fiskars was my first introduction to consumer product development. I contributed to work on several projects from concepting and prototyping for a new plier product line to testing validating and refining utility knives and hand saws in the pre-production tooling sample phase.',
    'Design and Prototyping': 'As a part of my work on the new pliers and wire cutter product lines, i participated in brainstorming sessions lead by the industrial design department and contributed to discussions around how to solve the specific user needs that our research report had identified. Coming out of that brainstorming session, I was assigned a couple of loose ideas to develop further into concepts and build prototypes for.',
    'Testing and Validating': 'The other main responsibility I had during this co-op was testing and validating against our benchmarks. In order to do this, I communicated with our partners overseas to plan how many samples we would receive and what tests each sample would go through. I then anylized the results of these tests and lead the discussions around the results with my team before communicating changes to our manufacturing partner. As a part of this validation, I had to build several new jigs to quantify certain functional attributes of the product.',
    'Process Improvement': 'Because this co-op was in the height of the pandemic, I was one of very few people in the office. As a result of this, I was responsible for operating and maintaining our Stratasys Objet30, HP MJF 5200, and Stratasys Fortus 450MC 3D printers. In maintaining these printers I noticed that the cleaning of the Objet\'s print bed created a mess as I had to scrape off the cured first layer, then vacuum up the flakes. To make my job easier, I modeled a scraper attachment for the shop vac using my new surface modeling skills to turn this job into one step.',
  },
  'head-puzzle': {
    'Project Overview': 'This puzzle box was the result of an independent study combining animatronic mechanisms with robotics and AI to create a sequential discovery puzzle in the form of a human head with a moving mouth and eyes that blink and look right at you.',
    'Mechanisms': 'The physical design incorporates simple linkages operated by servos to control eyelid, eyeball, and mouth movements. The head contains a camera positioned inside one eye, with buttons embedded in both ears and nostrils serving as control inputs. A hidden key is concealed within the skull and released by a solenoid when the mouth closes, simulating regurgitation.',
    'Electronics': 'The main control sequencing comes from a Jetson Nano running ROS. Inside the eye is a camera which feeds video to the Jetson. The servos are all connected to a servo driver driven by a MetroMini microcontroller which receives signals over serial from the Jetson. In the back of the head there is a speaker which play sounds in sync with some of the motions. The Jetson Nano lives up in the top of the head where a human\'s brain would be and there are two fans positioned by the heat sync to ensure the thermals are managed inside this plastic shell.',
    'Software': 'Control software is implemented in Python within a ROS container. The system features a main sequencing node that manages puzzle phases and transitions based on inputs from specialized nodes handling buttons, camera image recognition, speech/sound output, servo/solenoid control, and eye-tracking logic.',
  },
  'floating-yoda': {
    'Project Overview': 'I made this desk toy as part of my 10-week orientation sprint for my master\'s program. The prompt for this sprint was to create something that is \'Stranger Than Fiction\' and showcases who we are as a designer, so I built a levitating animatronic model of Baby Yoda to warm up my mechatronics and mechanism skills before the start of my classes.',
    'Technical Details': 'For this build I made use of an off the shelf levitating module and designed the animatronic Grogu to go on top. For the sculpt, I purchased an STL file of Grogu online and used SolidWorks to integrate the appropriate mechanisms to allow his head to rotate and his eyes to blink. The head and eye motion are controlled by a servo each and the servos are controlled my a small microcontroller in the base powered by a small LiPo battery. The head servo is programmed to sweep between random angles on random intervals and the eyes are programmed to blink in random timing to give Grogu a lifelike presence.',
  },
  'giant-etch-a-sketch': {
    'Project Overview': 'This coffee table sized Etch A Sketch was an exploration into how physical interactions with products can change with scale. We reimagined the original mechanism using a CNC gantry and a magnetized marble rolling on sand. This was a group project for a class about designing product interactions, I lead the team through the technical execution of this prototype.',
    'Design': 'There were several components that needed to interface in order to this project possible: the CNC gantry that drags the marble around the board, the knobs which read the inputs and sent commands to move the marble, and the sweeping mechanism that erases the drawing, and the outer curved housing made of plywood.',
    'Mechanisms': 'The gantry system was controlled by an Arduino Uno with a CNC shield running GRBL control software. The gantry received G-Code commands from a second Arduino which read the encoder positions of the knobs to determine what direction to move the marble. The clearing mechanism consists of a wide brush attached to a timing belt that sweeps the brush across the sand. The motion is controlled by a third Arduino that is reading an accelerometer to detect a shake.',
  },
  'traffic-light': {
    'Project Overview': 'The intention of this piece was to create a small world that exists inside an everyday object that could easily get overlooked. The object is a traffic light which at first glance seems normal, but upon closer inspection you will notice each bulb contains a civilization of little people and each civilization reacts very differently to the external stimuli of the changing traffic light.',
    'Design': 'I modeled the exterior in SolidWorks and 3D printed it in six components. The miniature figures were toy army men that I carved, melted, and painted. Clear Christmas ornaments serve as the dome covers for each light. The LEDs inside connect to a microcontroller housed in the green light. The lights are programmed to run in the traditional traffic signal sequence. The whole piece hangs from a string attached to the top housing.',
  },
  'parking-meter': {
    'Project Overview': 'I made this installation sculpture of a parking meter designed to bring awareness to the sale of Chicago\'s street parking spaces to a privatized company — when a coin is inserted into the installation, a miniature corporate office inside the meter flickers to life as if its lighting bill was paid for by that quarter.',
    'Design': 'This parking meter is based on the meters outside of my apartment. I modeled the body in SolidWorks and 3D-printed it. The windows are heat formed acrylic panels. The office inside consists of hand painted 3D printed office decor. Within the body of the meter I designed cavities and grooves to house the electronics that detect the coins and trigger the LEDs to turn on.',
  },
  'mechanical-jewelry': {
    'Project Overview': 'These pieces are a part of my body of work from two courses in art metal that I took in undergrad. Each of these pieces was designed from the ground up with some mechanism, electronics, or combination of the two.',
    'Moon Pendant': 'This pendant was my main project in my advanced art metal class. The majority of the pieces were carved in wax then cast out of sterling silver. The eyes are two garnet stones set into the piece and behind them are two LEDs that light up when a magnet is brought close. The eyelids open and close when the chain loop is pulled in and out.',
    'Ring Lighter': 'This ring was the final project for my intro art metal class. I thought it would be challenging to fit a functional lighter inside a signet style ring, so I chose to do exactly that. I used SolidWorks to plan it out and printed off drawings to use as cut templates. The ring was constructed using silver solder to join the pieces. The lighter is refilled by pulling the striker assembly out revealing a tube to the inside.',
    'Handcuff Ring': 'This ring was my first cast piece of jewlery. The design was made in SolidWorks then 3D printed using standard clear resin on an SLA machine. The 3D prints were then set in plaster and burnt out leaving a cavity into which silver was cast. There is a small steel spring on the inside to give the handcuffs a locking action, and the screw on the bottom adjusts the tension of this spring to release.',
    'Pinky Promise Ring': 'I made this ring as a challenge to set a stone with something different than a typical prong setting. The two interlocking pinkies make up two of the prongs and the stone is held securely with two smaller prongs. The pinkies were carved out of the solid brass rod using rotary tool bits.',
  },
};

const selectProject = db.prepare('SELECT sections FROM projects WHERE slug = ?');
const updateProject = db.prepare('UPDATE projects SET sections = ? WHERE slug = ?');

let totalUpdated = 0;

for (const [slug, sectionTexts] of Object.entries(text)) {
  const row = selectProject.get(slug);
  if (!row) { console.log('✗ not found:', slug); continue; }

  const sections = JSON.parse(row.sections);

  // For mechanical-jewelry: insert Project Overview at position 0 if missing
  if (slug === 'mechanical-jewelry' && !sections.find(s => s.heading === 'Project Overview')) {
    const { randomUUID } = require('crypto');
    sections.unshift({ id: randomUUID(), heading: 'Project Overview', body: sectionTexts['Project Overview'], images: [] });
    console.log('  + inserted Project Overview for mechanical-jewelry');
  }

  let updated = 0;
  for (const sec of sections) {
    if (sec.heading in sectionTexts) {
      const newBody = sectionTexts[sec.heading];
      if (sec.body !== newBody) {
        sec.body = newBody;
        updated++;
      }
    }
  }

  updateProject.run(JSON.stringify(sections), slug);
  console.log(`✓ ${slug}: ${updated} section(s) updated`);
  totalUpdated += updated;
}

console.log(`\nDone. ${totalUpdated} total sections updated.`);
