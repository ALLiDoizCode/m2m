import { parseSocks5hUrl } from '../../../src/transport/socks-url';

describe('parseSocks5hUrl', () => {
  it('should parse a valid socks5h URL', () => {
    const result = parseSocks5hUrl('socks5h://127.0.0.1:9050');
    expect(result).toEqual({ host: '127.0.0.1', port: 9050 });
  });

  it('should throw on empty string', () => {
    expect(() => parseSocks5hUrl('')).toThrow(
      'socksProxy must be a non-empty string starting with "socks5h://"'
    );
  });

  it('should throw on non-string input', () => {
    expect(() => parseSocks5hUrl(null as any)).toThrow(
      'socksProxy must be a non-empty string starting with "socks5h://"'
    );
  });

  it('should throw on socks5:// scheme (without h)', () => {
    expect(() => parseSocks5hUrl('socks5://127.0.0.1:9050')).toThrow(
      'socksProxy scheme must be "socks5h://"'
    );
  });

  it('should throw on http:// scheme', () => {
    expect(() => parseSocks5hUrl('http://127.0.0.1:9050')).toThrow(
      'socksProxy scheme must be "socks5h://"'
    );
  });

  it('should throw on invalid URL format', () => {
    // URL constructor may parse some "invalid" strings as hostnames;
    // truly malformed URLs throw at the constructor level
    expect(() => parseSocks5hUrl('socks5h://')).toThrow('socksProxy is not a valid URL');
  });

  it('should throw on missing port', () => {
    expect(() => parseSocks5hUrl('socks5h://127.0.0.1')).toThrow(
      'socksProxy must include a valid host and port'
    );
  });

  it('should throw on out-of-range port', () => {
    // URL constructor throws for ports > 65535
    expect(() => parseSocks5hUrl('socks5h://127.0.0.1:70000')).toThrow(
      'socksProxy is not a valid URL'
    );
  });

  it('should throw on negative port', () => {
    // URL constructor throws for negative ports
    expect(() => parseSocks5hUrl('socks5h://127.0.0.1:-1')).toThrow(
      'socksProxy is not a valid URL'
    );
  });

  it('should parse localhost with default port', () => {
    // URL without explicit port - port will be empty string
    expect(() => parseSocks5hUrl('socks5h://localhost')).toThrow(
      'socksProxy must include a valid host and port'
    );
  });

  it('should parse URL with hostname', () => {
    const result = parseSocks5hUrl('socks5h://proxy.example.com:1080');
    expect(result).toEqual({ host: 'proxy.example.com', port: 1080 });
  });
});
