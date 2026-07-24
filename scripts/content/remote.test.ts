import { describe, expect, it } from 'vitest';

import { downloadRemoteFile, isBlockedAddress } from './remote.ts';

describe('remote content retrieval policy', () => {
  it('rejects non-HTTPS, credentialed, and localhost destinations', async () => {
    await expect(
      downloadRemoteFile('http://example.com/music.psg'),
    ).rejects.toThrow('must use HTTPS');
    await expect(
      downloadRemoteFile('https://user:secret@example.com/music.psg'),
    ).rejects.toThrow('contains credentials');
    await expect(
      downloadRemoteFile('https://localhost/music.psg'),
    ).rejects.toThrow('destination is localhost');
  });

  it.each([
    // IPv4 private, loopback, link-local, CGNAT, documentation, multicast.
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    // IPv6, including fully expanded forms a text prefix check would miss.
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80:0000:0000:0000:0000:0000:0000:0001',
    'ff02::1',
    '2001:db8::1',
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    // Not an address at all.
    'not-an-address',
    '1.2.3',
    '999.1.1.1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80f::200e',
    '2001:db9::1',
  ])('allows public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});
