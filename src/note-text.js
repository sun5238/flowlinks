function encodeNote(note) {
  return note.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n');
}

function decodeNote(input) {
  let note = '';
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\' && input[i + 1] === 'n') {
      note += '\n';
      i++;
    } else if (input[i] === '\\' && input[i + 1] === '\\') {
      note += '\\';
      i++;
    } else {
      note += input[i];
    }
  }
  return note;
}

module.exports = { encodeNote, decodeNote };
