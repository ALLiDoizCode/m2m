import { AlertNotifier } from '../../../src/security/alert-notifier';

const mockLogger = {
  child: jest.fn().mockReturnThis(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('AlertNotifier branch coverage', () => {
  let notifier: AlertNotifier;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should exhaust email retries and log error', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      email: { enabled: true, recipients: ['test@example.com'], smtpHost: 'localhost' },
      retryAttempts: 2,
      retryDelayMs: 10,
    });

    jest.spyOn(notifier as any, 'sendEmailAlertInternal').mockRejectedValue(new Error('SMTP down'));

    await notifier.sendEmailAlert('high', 'Test message');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to send email alert after retries',
      expect.objectContaining({ error: 'SMTP down' })
    );
  });

  it('should handle non-Error in email retry catch', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      email: { enabled: true, recipients: ['test@example.com'], smtpHost: 'localhost' },
      retryAttempts: 1,
      retryDelayMs: 1,
    });

    jest.spyOn(notifier as any, 'sendEmailAlertInternal').mockRejectedValue('string-error');

    await notifier.sendEmailAlert('high', 'Test message');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('should return early when email not enabled', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      email: { enabled: false, recipients: [], smtpHost: '' },
    });
    jest.clearAllMocks();

    await notifier.sendEmailAlert('high', 'Test message');
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('should exhaust Slack retries and log error', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      slack: { enabled: true, webhookUrl: 'http://localhost', channel: '#alerts' },
      retryAttempts: 2,
      retryDelayMs: 10,
    });

    jest
      .spyOn(notifier as any, 'sendSlackAlertInternal')
      .mockRejectedValue(new Error('Network error'));

    await notifier.sendSlackAlert('high', 'Test message');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to send Slack alert after retries',
      expect.objectContaining({ error: 'Network error' })
    );
  });

  it('should handle non-Error in Slack retry catch', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      slack: { enabled: true, webhookUrl: 'http://localhost', channel: '#alerts' },
      retryAttempts: 1,
      retryDelayMs: 1,
    });

    jest.spyOn(notifier as any, 'sendSlackAlertInternal').mockRejectedValue(12345);

    await notifier.sendSlackAlert('high', 'Test message');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('should return early when Slack not enabled', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      slack: { enabled: false, webhookUrl: '', channel: '' },
    });
    jest.clearAllMocks();

    await notifier.sendSlackAlert('high', 'Test message');
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('should send email successfully on first attempt', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      email: { enabled: true, recipients: ['test@example.com'], smtpHost: 'localhost' },
    });

    await notifier.sendEmailAlert('critical', 'Urgent!');
    expect(mockLogger.info).toHaveBeenCalledWith('Email alert sent successfully', {
      severity: 'critical',
      attempt: 0,
    });
  });

  it('should send Slack successfully on first attempt', async () => {
    notifier = new AlertNotifier(mockLogger as any, {
      slack: { enabled: true, webhookUrl: 'http://localhost', channel: '#alerts' },
    });

    await notifier.sendSlackAlert('critical', 'Urgent!');
    expect(mockLogger.info).toHaveBeenCalledWith('Slack alert sent successfully', {
      severity: 'critical',
      attempt: 0,
    });
  });
});
