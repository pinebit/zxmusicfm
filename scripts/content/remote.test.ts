import { describe, expect, it } from 'vitest';

import { downloadRemoteFile } from './remote.ts';

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
});
