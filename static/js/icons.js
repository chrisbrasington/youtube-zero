'use strict';

/*
 * Folder icon picker (emoji popover).
 *
 * Classic script. Owns EMOJI_SET (catalog with search keywords),
 * the picker open/close lifecycle, and the inline event wiring for
 * search input, Escape-to-close, and click-outside-to-close.
 *
 * Picking an emoji POSTs to /api/folders/:id/set-icon and updates
 * state.feed.folders[].icon locally for an immediate re-render.
 */

// [emoji, 'space-separated search keywords']
const EMOJI_SET = [
  // Folders / organization
  ['📁','folder files default'],['🗂️','folder tabs organize'],['🗃️','file cabinet archive'],
  ['📂','folder open'],['🗄️','cabinet storage files'],['📌','pin bookmark'],
  ['🔖','bookmark save'],['📋','clipboard list'],['📎','paperclip attach'],
  ['🗒️','notepad memo list'],['🗓️','calendar schedule date'],['📅','calendar date'],
  // Gaming
  ['🎮','gaming game controller play'],['🕹️','joystick arcade retro gaming'],
  ['👾','alien space invaders retro gaming'],['🏆','trophy winner achievement gaming'],
  ['🎯','target dart gaming aim'],['🎲','dice board game random'],['♟️','chess strategy game'],
  ['🃏','cards poker game'],['🎳','bowling game'],['🎰','slot casino gambling'],
  ['👑','crown king winner royalty'],['⚔️','sword battle rpg fight'],['🛡️','shield defense rpg'],
  ['🗡️','dagger rpg battle'],['🏹','bow arrow rpg ranger'],['🧩','puzzle game brain'],
  ['🀄','mahjong game tiles'],['🎪','carnival fun fair'],['🎠','carousel fun fair'],
  ['🧸','teddy bear toy cute'],['🪀','yoyo toy game'],['🪁','slingshot toy'],
  ['🎭','theater drama role play'],['🃏','joker wild card'],
  // Pirate / adventure
  ['🏴‍☠️','pirate flag skull crossbones jolly roger'],['☠️','skull crossbones death pirate'],
  ['🗺️','map treasure adventure explore'],['⚓','anchor nautical ship boat'],
  ['🦜','parrot pirate bird'],['🪝','hook pirate captain'],['🧭','compass navigate explore'],
  ['⛵','sailboat ship sea adventure'],['🚢','ship cruise ocean travel'],
  // Video / streaming
  ['📺','tv television watch stream'],['🎬','film clapper movie video'],
  ['🎥','camera movie film video'],['📹','video camera record'],
  ['🎞️','film strip movie'],['📽️','projector film cinema'],['🎦','cinema movie watch'],
  ['▶️','play button stream watch'],['📡','satellite broadcast stream dish'],
  ['🎙️','microphone podcast recording'],['📸','photo camera photography'],
  // Music / audio
  ['🎵','music note song'],['🎶','music notes songs'],['🎸','guitar music rock'],
  ['🎹','piano keyboard music'],['🎺','trumpet music brass'],['🥁','drums music beat'],
  ['🎷','saxophone music jazz'],['🎻','violin music classical'],['🎤','microphone sing vocal'],
  ['🎧','headphones music listen'],['📻','radio music broadcast'],['🔊','speaker volume sound'],
  ['🪗','accordion music folk'],['🪘','drum music percussion'],['🎼','sheet music score'],
  ['🪕','banjo country folk music'],['🔔','bell ring alert sound'],['🎚️','mixer fader audio'],
  // Tech / coding
  ['💻','laptop computer coding tech'],['🖥️','desktop monitor computer'],
  ['📱','phone mobile smartphone'],['⌨️','keyboard typing code'],['🖱️','mouse computer'],
  ['🔧','wrench tool fix repair'],['⚙️','gear settings config'],['🤖','robot ai automation'],
  ['💾','disk save data retro'],['🔌','plug power electric'],['🖨️','printer tech office'],
  ['💡','lightbulb idea innovation'],['🔋','battery power charge'],['📲','phone app download'],
  ['🧑‍💻','developer coder programmer tech'],['👨‍💻','programmer developer code'],
  ['🖲️','trackball mouse computer'],['💿','cd disc data optical'],['📀','dvd disc media'],
  ['🧮','abacus math calculate'],['📟','pager beeper retro tech'],['☎️','phone telephone retro'],
  ['🔦','flashlight torch light'],['🔭','telescope astronomy space look'],
  // Science / research
  ['🔬','microscope science lab research'],['🧬','dna biology genetics science'],
  ['🧪','flask chemistry science lab test'],['🌡️','thermometer temperature measure'],
  ['⚗️','beaker chemistry lab experiment'],['🧫','petri dish biology culture'],
  ['🧲','magnet physics attract'],['⚛️','atom physics nuclear quantum'],
  ['🔩','bolt screw engineering mechanical'],['🧰','toolbox repair fix build'],
  ['🪛','screwdriver fix tool'],['🪚','saw cut wood tool'],['⚒️','hammer pick tool'],
  // Nature / outdoors
  ['🌿','plant nature green herb'],['🌲','tree pine forest nature'],['🌊','wave ocean water sea'],
  ['🔥','fire flame hot energy'],['⭐','star favorite gold'],['🌙','moon night crescent'],
  ['☀️','sun day bright solar'],['🌸','cherry blossom flower spring japan'],
  ['🍀','clover lucky green four'],['🌈','rainbow color pride'],
  ['⚡','lightning bolt electric storm energy'],['❄️','snowflake cold winter ice frost'],
  ['🍃','leaf nature plant wind'],['🌺','hibiscus flower tropical'],['🌻','sunflower yellow bright'],
  ['🌵','cactus desert dry'],['🍄','mushroom fungi nature'],['🌾','wheat grain harvest farm'],
  ['🪨','rock stone boulder'],['🪸','coral ocean reef sea'],['🐚','shell ocean beach'],
  ['🌋','volcano fire mountain lava'],['🏜️','desert sand dry heat'],['🏕️','camp tent outdoor'],
  ['🧊','ice cube cold freeze'],['💧','water drop rain'],['🌪️','tornado storm wind'],
  // Space
  ['🚀','rocket space launch nasa'],['🛸','ufo space alien flying saucer'],
  ['🌍','earth globe world europe africa'],['🌎','earth globe americas'],
  ['🌕','full moon lunar space'],['🌌','galaxy milky way space stars'],
  ['🪐','saturn planet rings space'],['🛰️','satellite space orbit'],
  ['☄️','comet meteor space asteroid'],['🌠','shooting star wish space'],
  ['🔭','telescope astronomy observe'],['👨‍🚀','astronaut space explore'],
  // Sports / fitness
  ['⚽','soccer football sport ball'],['🏀','basketball sport nba'],
  ['🏈','football american sport nfl'],['⚾','baseball sport mlb'],
  ['🎾','tennis sport court'],['🏐','volleyball sport net'],['🎱','billiards pool sport cue'],
  ['🏊','swimming sport pool'],['🚴','cycling bike sport road'],
  ['🏋️','weightlifting gym fitness strength'],['🤸','gymnastics sport flexibility'],
  ['🥊','boxing sport fight gloves'],['🏄','surfing sport wave ocean'],
  ['⛷️','skiing sport winter snow'],['🧗','climbing sport wall bouldering'],
  ['🏇','horse racing sport jockey'],['🤼','wrestling sport fight'],['🥋','martial arts karate'],
  ['🏒','hockey stick ice sport'],['🎿','ski winter sport snow'],['🧘','yoga meditation fitness'],
  ['🏸','badminton sport racquet'],['🏓','ping pong table tennis'],['🥅','goal net sport'],
  ['🏌️','golf sport club'],['🤺','fencing sword sport'],['🧜','mermaid swim fantasy'],
  // Food / drink
  ['🍕','pizza food italian'],['🍔','burger food fast'],['🍜','noodles ramen food asian'],
  ['🍣','sushi japanese food raw'],['☕','coffee drink hot morning'],['🍺','beer drink pub'],
  ['🥤','drink soda juice cold'],['🍰','cake dessert sweet slice'],['🍩','donut sweet pastry'],
  ['🌮','taco mexican food'],['🍎','apple fruit red healthy'],['🥑','avocado food green healthy'],
  ['🍜','ramen noodle soup'],['🧁','cupcake cake sweet'],['🍫','chocolate sweet candy'],
  ['🍻','cheers beer toast drink'],['🥂','champagne toast celebrate'],['🍷','wine red drink'],
  ['🧃','juice box drink kids'],['🍵','tea green cup hot'],['🥃','whiskey spirit drink'],
  ['🍪','cookie bake sweet'],['🎂','birthday cake celebrate'],['🥞','pancakes breakfast food'],
  // Travel / places
  ['✈️','airplane travel fly flight'],['🚗','car drive road travel'],
  ['🚂','train rail steam travel'],['🏠','home house building'],
  ['🏖️','beach vacation sun sand'],['🧭','compass navigate explore direction'],
  ['🗼','eiffel tower paris france'],['🏔️','mountain peak hiking climb'],
  ['🌆','city skyline urban evening'],['🏝️','island tropical paradise'],
  ['🚁','helicopter fly air'],['🏎️','race car fast speed'],['🚂','locomotive train steam'],
  ['🗽','statue liberty new york usa'],['🏯','castle japan fortress'],
  ['⛩️','shrine japan torii gate'],['🌁','foggy bridge san francisco'],
  ['🚠','cable car mountain transport'],['🛶','canoe kayak paddle water'],
  ['🏟️','stadium arena sport venue'],['🎡','ferris wheel fair carnival'],
  // Art / creative
  ['🎨','palette art paint design color'],['✏️','pencil draw sketch write'],
  ['📝','note memo write journal'],['📚','books read study library learn'],
  ['🖼️','picture art frame gallery painting'],['🖌️','brush paint art stroke'],
  ['🖊️','pen write ink sign'],['📐','ruler triangle drawing geometry'],
  ['🪡','thread sew craft'],['🧶','yarn knit craft wool'],['🧵','thread sew stitch'],
  ['🪆','matryoshka doll russia craft'],['🗿','moai statue art mystery'],
  ['🏺','vase pottery ancient art'],['🎠','carousel art design'],
  // Business / finance
  ['💼','briefcase business work professional'],['📊','bar chart graph data analytics'],
  ['💰','money bag finance wealth rich'],['📈','chart up growth trend'],
  ['🏦','bank finance institution'],['📉','chart down decline loss'],
  ['🤝','handshake deal agreement'],['📣','megaphone announce loud'],
  ['💳','credit card payment'],['🏧','atm cash machine bank'],
  ['📦','box package shipping delivery'],['🏪','store shop retail'],
  ['🏬','department store mall shopping'],['🏢','office building work'],
  // People / roles
  ['👨‍🍳','chef cook food kitchen'],['👩‍🎨','artist creative design paint'],
  ['🧑‍🎤','singer musician rock star perform'],['👨‍🚀','astronaut space pilot'],
  ['🧑‍🔬','scientist researcher lab'],['👨‍⚕️','doctor medical health'],
  ['🧑‍🏫','teacher professor education learn'],['👷','worker construction hard hat'],
  ['🕵️','detective spy mystery investigate'],['🧙','wizard mage magic fantasy'],
  ['🧝','elf fantasy magic nature'],['🧛','vampire halloween dark fantasy'],
  ['🧟','zombie undead horror'],['🤠','cowboy western hat'],['🥷','ninja stealth martial'],
  // Animals
  ['🐱','cat pet animal meow'],['🐶','dog pet animal woof'],['🦊','fox animal clever'],
  ['🦁','lion animal king jungle'],['🐺','wolf animal howl pack'],['🦅','eagle bird sky'],
  ['🐉','dragon fantasy fire mythical'],['🦄','unicorn fantasy magic rainbow'],
  ['🐻','bear animal forest'],['🐼','panda animal cute china'],
  ['🦋','butterfly nature insect transform'],['🐬','dolphin ocean smart animal'],
  ['🐸','frog amphibian green'],['🦎','lizard reptile gecko'],['🐍','snake reptile python'],
  ['🦆','duck bird water quack'],['🦉','owl bird night wisdom'],['🐧','penguin bird cold'],
  ['🦈','shark ocean fish danger'],['🐙','octopus sea tentacle'],['🦑','squid sea ocean'],
  ['🐝','bee honey insect pollinate'],['🦟','mosquito insect bug'],['🕷️','spider web arachnid'],
  ['🦖','t-rex dinosaur prehistoric fossil'],['🦕','brachiosaurus dinosaur prehistoric'],
  ['🐲','dragon mythical fantasy green'],['🐊','crocodile alligator reptile'],
  // Flags / special
  ['🏴‍☠️','pirate jolly roger skull flag black'],['🏳️‍🌈','rainbow pride flag colorful'],
  ['🚩','red flag warning marker location'],['🏁','checkered flag finish race'],
  ['🎌','crossed flags japan ceremony'],['🏳️','white flag surrender peace'],
  ['🏴','black flag'],['🇺🇸','usa american flag united states'],
  // Misc / symbols
  ['❤️','heart love favorite red'],['💜','purple heart'],['💙','blue heart'],
  ['💚','green heart'],['🧡','orange heart'],['💛','yellow heart'],['🖤','black heart'],
  ['🔑','key unlock access security'],['🎁','gift present birthday surprise'],
  ['🎉','party popper celebrate'],['🌐','globe web internet network'],
  ['💫','dizzy star spin special'],['✨','sparkle magic shine glitter'],
  ['🎊','confetti celebrate party'],['🔐','lock closed secure private'],
  ['⚠️','warning alert caution danger'],['✅','check done complete success'],
  ['🏷️','tag label price'],['🔮','crystal ball magic predict future'],
  ['🧿','evil eye protect talisman'],['🪬','evil eye amulet protect'],
  ['♻️','recycle green eco environment'],['⚜️','fleur de lis symbol'],
  ['🔯','star of david hexagram'],['☯️','yin yang balance peace'],
  ['☮️','peace sign symbol'],['⚡','lightning bolt fast energy electric'],
  ['💎','diamond gem precious jewel'],['🪙','coin money gold silver'],
  ['🧲','magnet attract pull force'],['🪄','magic wand wizard spell'],
  ['🎀','ribbon bow gift decoration'],['🎗️','ribbon awareness cause'],
  ['🪞','mirror reflect vanity'],['🪟','window view glass'],['🛋️','sofa couch relax'],
  ['🪑','chair seat sit'],['🚪','door entrance exit room'],
  ['🧸','teddy bear plush soft cute'],['🪆','nesting doll matryoshka'],
  ['🏮','red lantern japan festival light'],['🪔','diya candle light india'],
  ['🕯️','candle flame light warm'],['💈','barber pole hair cut'],
  ['🗺️','world map geography globe explore'],
];

let pickerFolderId = null;


function showIconPicker(folderId, anchorEl) {
  pickerFolderId = folderId;
  const picker = $('icon-picker');
  $('icon-search').value = '';
  renderIconGrid('');
  picker.classList.remove('hidden');

  // Position below anchor, clamp to viewport
  const rect   = anchorEl.getBoundingClientRect();
  const pw     = ICON_PICKER_WIDTH;
  const left   = Math.min(rect.left, window.innerWidth - pw - 8);
  let   top    = rect.bottom + 4;
  if (top + ICON_PICKER_HEIGHT > window.innerHeight) top = rect.top - ICON_PICKER_FLIP_GAP;
  picker.style.left = `${Math.max(4, left)}px`;
  picker.style.top  = `${Math.max(4, top)}px`;

  $('icon-search').focus();
}


function hideIconPicker() {
  $('icon-picker').classList.add('hidden');
  pickerFolderId = null;
}


function renderIconGrid(query) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? EMOJI_SET.filter(([, kw]) => kw.includes(q))
    : EMOJI_SET;
  $('icon-grid').innerHTML = filtered
    .map(([emoji]) =>
      `<button class="icon-btn" data-action="pick-icon" data-emoji="${escAttr(emoji)}">${emoji}</button>`
    ).join('');
}


async function setFolderIcon(folderId, icon) {
  try {
    await api.post(`/api/folders/${folderId}/set-icon`, { icon });
    const folder = findFolder(folderId);
    if (folder) folder.icon = icon;
    render();
  } catch (e) {
    status('Error: ' + e.message, 'err');
  }
}


// ── Event wiring (search input + escape/outside-click to close) ──────────────

$('icon-search').addEventListener('input', e => renderIconGrid(e.target.value));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pickerFolderId) { hideIconPicker(); return; }
});

document.addEventListener('mousedown', e => {
  if (pickerFolderId && !e.target.closest('#icon-picker') && !e.target.closest('[data-action="open-icon-picker"]')) {
    hideIconPicker();
  }
});
