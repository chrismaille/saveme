export function seededRandom(seed = 0x5eed1234) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

export function randomInt(random, min, max) {
    return min + Math.floor(random() * (max - min + 1));
}

export function pick(random, values) {
    return values[Math.floor(random() * values.length)];
}

export function randomString(random, alphabet, min, max) {
    const length = randomInt(random, min, max);
    let value = '';
    for (let i = 0; i < length; i++)
        value += alphabet[Math.floor(random() * alphabet.length)];
    return value;
}
