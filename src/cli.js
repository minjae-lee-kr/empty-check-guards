// Tiny strict parser shared by the examples. It does not perform domain validation.
export function parseArguments(argv, { values = [], flags = [] } = {}) {
  const options = Object.create(null);
  const positionals = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (positionalOnly || !argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    if (!values.includes(argument) && !flags.includes(argument)) {
      throw new Error(`unknown option: ${argument}`);
    }
    if (Object.hasOwn(options, argument)) throw new Error(`duplicate option: ${argument}`);
    if (flags.includes(argument)) {
      options[argument] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument] = value;
  }
  return { options, positionals };
}
