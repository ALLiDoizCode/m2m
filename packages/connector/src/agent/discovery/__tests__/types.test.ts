import {
  type AgentType,
  type PricingEntry,
  type CapacityInfo,
  type AgentCapabilities,
  type AgentMetadata,
  type AgentCapability,
  AgentCapabilitiesSchema,
  AgentMetadataSchema,
  PricingEntrySchema,
  CapacityInfoSchema,
  AgentCapabilitySchema,
  validateAgentCapability,
  validateAgentMetadata,
  TAG_NAMES,
} from '../types';

describe('Agent Discovery Types', () => {
  describe('AgentType', () => {
    it('should accept all five agent type values', () => {
      const types: AgentType[] = ['dvm', 'assistant', 'specialist', 'coordinator', 'relay'];

      types.forEach((type) => {
        expect(['dvm', 'assistant', 'specialist', 'coordinator', 'relay']).toContain(type);
      });
    });
  });

  describe('PricingEntry', () => {
    it('should create valid pricing entry with bigint amount', () => {
      const pricing: PricingEntry = {
        kind: 5000,
        amount: BigInt(100),
        currency: 'msat',
      };

      expect(pricing.kind).toBe(5000);
      expect(pricing.amount).toBe(BigInt(100));
      expect(pricing.currency).toBe('msat');
    });

    it('should support all currency types', () => {
      const currencies: Array<'msat' | 'sat' | 'usd'> = ['msat', 'sat', 'usd'];

      currencies.forEach((currency) => {
        const pricing: PricingEntry = {
          kind: 5000,
          amount: BigInt(100),
          currency,
        };

        expect(pricing.currency).toBe(currency);
      });
    });
  });

  describe('CapacityInfo', () => {
    it('should create valid capacity info', () => {
      const capacity: CapacityInfo = {
        maxConcurrent: 10,
        queueDepth: 100,
      };

      expect(capacity.maxConcurrent).toBe(10);
      expect(capacity.queueDepth).toBe(100);
    });

    it('should allow zero queue depth', () => {
      const capacity: CapacityInfo = {
        maxConcurrent: 5,
        queueDepth: 0,
      };

      expect(capacity.queueDepth).toBe(0);
    });
  });

  describe('AgentCapabilities', () => {
    it('should create capabilities with all fields', () => {
      const capabilities: AgentCapabilities = {
        languages: ['en', 'es', 'fr'],
        domains: ['finance', 'legal'],
        maxContextTokens: 100000,
      };

      expect(capabilities.languages).toEqual(['en', 'es', 'fr']);
      expect(capabilities.domains).toEqual(['finance', 'legal']);
      expect(capabilities.maxContextTokens).toBe(100000);
    });

    it('should create capabilities with optional fields omitted', () => {
      const capabilities: AgentCapabilities = {
        languages: ['en'],
      };

      expect(capabilities.languages).toEqual(['en']);
      expect(capabilities.domains).toBeUndefined();
      expect(capabilities.maxContextTokens).toBeUndefined();
    });

    it('should create empty capabilities object', () => {
      const capabilities: AgentCapabilities = {};

      expect(capabilities.languages).toBeUndefined();
      expect(capabilities.domains).toBeUndefined();
      expect(capabilities.maxContextTokens).toBeUndefined();
    });
  });

  describe('AgentMetadata', () => {
    it('should create metadata with all fields', () => {
      const metadata: AgentMetadata = {
        name: 'Alice Agent',
        about: 'AI agent specializing in finance',
        picture: 'https://example.com/avatar.png',
        website: 'https://alice.example.com',
        nip05: 'alice@example.com',
        lud16: 'alice@lightning.example.com',
        capabilities: {
          languages: ['en'],
          domains: ['finance'],
          maxContextTokens: 100000,
        },
      };

      expect(metadata.name).toBe('Alice Agent');
      expect(metadata.about).toBe('AI agent specializing in finance');
      expect(metadata.picture).toBe('https://example.com/avatar.png');
      expect(metadata.capabilities?.languages).toEqual(['en']);
    });

    it('should create metadata with only required name field', () => {
      const metadata: AgentMetadata = {
        name: 'Bob Agent',
      };

      expect(metadata.name).toBe('Bob Agent');
      expect(metadata.about).toBeUndefined();
      expect(metadata.picture).toBeUndefined();
    });
  });

  describe('AgentCapability', () => {
    it('should create complete capability with all fields', () => {
      const capability: AgentCapability = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        identifier: 'g.agent.alice',
        supportedKinds: [5000, 5100],
        supportedNips: ['89', '90', 'xx1'],
        agentType: 'dvm',
        ilpAddress: 'g.agent.alice',
        pricing: new Map([
          [5000, { kind: 5000, amount: BigInt(100), currency: 'msat' }],
          [5100, { kind: 5100, amount: BigInt(5000), currency: 'msat' }],
        ]),
        capacity: {
          maxConcurrent: 10,
          queueDepth: 100,
        },
        model: 'anthropic:claude-haiku-4-5',
        skills: ['query', 'translate'],
        metadata: {
          name: 'Alice Agent',
          about: 'Finance specialist',
        },
        createdAt: 1234567890,
      };

      expect(capability.pubkey).toHaveLength(64);
      expect(capability.supportedKinds).toEqual([5000, 5100]);
      expect(capability.agentType).toBe('dvm');
      expect(capability.pricing.size).toBe(2);
      expect(capability.pricing.get(5000)?.amount).toBe(BigInt(100));
    });

    it('should create capability with optional fields omitted', () => {
      const capability: AgentCapability = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        identifier: 'g.agent.bob',
        supportedKinds: [5000],
        supportedNips: ['89'],
        agentType: 'assistant',
        ilpAddress: 'g.agent.bob',
        pricing: new Map([[5000, { kind: 5000, amount: BigInt(50), currency: 'msat' }]]),
        metadata: {
          name: 'Bob Agent',
        },
        createdAt: 1234567890,
      };

      expect(capability.capacity).toBeUndefined();
      expect(capability.model).toBeUndefined();
      expect(capability.skills).toBeUndefined();
    });
  });

  describe('TAG_NAMES Constants', () => {
    it('should define all required tag names', () => {
      expect(TAG_NAMES.IDENTIFIER).toBe('d');
      expect(TAG_NAMES.KIND).toBe('k');
      expect(TAG_NAMES.NIP).toBe('nip');
      expect(TAG_NAMES.AGENT_TYPE).toBe('agent-type');
      expect(TAG_NAMES.ILP_ADDRESS).toBe('ilp-address');
      expect(TAG_NAMES.PRICING).toBe('pricing');
      expect(TAG_NAMES.CAPACITY).toBe('capacity');
      expect(TAG_NAMES.MODEL).toBe('model');
      expect(TAG_NAMES.SKILLS).toBe('skills');
    });
  });
});

describe('Zod Schemas', () => {
  describe('AgentCapabilitiesSchema', () => {
    it('should validate valid capabilities with all fields', () => {
      const data = {
        languages: ['en', 'es'],
        domains: ['finance', 'legal'],
        maxContextTokens: 100000,
      };

      const result = AgentCapabilitiesSchema.parse(data);

      expect(result).toEqual(data);
    });

    it('should validate capabilities with optional fields omitted', () => {
      const data = {
        languages: ['en'],
      };

      const result = AgentCapabilitiesSchema.parse(data);

      expect(result.languages).toEqual(['en']);
      expect(result.domains).toBeUndefined();
    });

    it('should validate empty capabilities object', () => {
      const data = {};

      const result = AgentCapabilitiesSchema.parse(data);

      expect(result).toEqual({});
    });

    it('should reject negative maxContextTokens', () => {
      const data = {
        maxContextTokens: -1000,
      };

      expect(() => AgentCapabilitiesSchema.parse(data)).toThrow();
    });

    it('should reject non-integer maxContextTokens', () => {
      const data = {
        maxContextTokens: 100.5,
      };

      expect(() => AgentCapabilitiesSchema.parse(data)).toThrow();
    });
  });

  describe('AgentMetadataSchema', () => {
    it('should validate valid metadata with all fields', () => {
      const data = {
        name: 'Alice Agent',
        about: 'Finance specialist',
        picture: 'https://example.com/avatar.png',
        website: 'https://alice.example.com',
        nip05: 'alice@example.com',
        lud16: 'alice@lightning.example.com',
        capabilities: {
          languages: ['en'],
        },
      };

      const result = AgentMetadataSchema.parse(data);

      expect(result).toEqual(data);
    });

    it('should validate metadata with only required name', () => {
      const data = {
        name: 'Bob Agent',
      };

      const result = AgentMetadataSchema.parse(data);

      expect(result.name).toBe('Bob Agent');
    });

    it('should reject metadata without name', () => {
      const data = {
        about: 'Agent without name',
      };

      expect(() => AgentMetadataSchema.parse(data)).toThrow();
    });

    it('should reject empty name', () => {
      const data = {
        name: '',
      };

      expect(() => AgentMetadataSchema.parse(data)).toThrow();
    });

    it('should reject invalid picture URL', () => {
      const data = {
        name: 'Agent',
        picture: 'not-a-url',
      };

      expect(() => AgentMetadataSchema.parse(data)).toThrow();
    });

    it('should reject invalid website URL', () => {
      const data = {
        name: 'Agent',
        website: 'invalid-website',
      };

      expect(() => AgentMetadataSchema.parse(data)).toThrow();
    });
  });

  describe('PricingEntrySchema', () => {
    it('should validate pricing with bigint amount', () => {
      const data = {
        kind: 5000,
        amount: BigInt(100),
        currency: 'msat',
      };

      const result = PricingEntrySchema.parse(data);

      expect(result.kind).toBe(5000);
      expect(result.amount).toBe(BigInt(100));
      expect(result.currency).toBe('msat');
    });

    it('should transform string amount to bigint', () => {
      const data = {
        kind: 5000,
        amount: '100',
        currency: 'msat',
      };

      const result = PricingEntrySchema.parse(data);

      expect(result.amount).toBe(BigInt(100));
    });

    it('should transform number amount to bigint', () => {
      const data = {
        kind: 5000,
        amount: 100,
        currency: 'msat',
      };

      const result = PricingEntrySchema.parse(data);

      expect(result.amount).toBe(BigInt(100));
    });

    it('should reject negative kind', () => {
      const data = {
        kind: -5000,
        amount: BigInt(100),
        currency: 'msat',
      };

      expect(() => PricingEntrySchema.parse(data)).toThrow();
    });

    it('should reject invalid currency', () => {
      const data = {
        kind: 5000,
        amount: BigInt(100),
        currency: 'btc',
      };

      expect(() => PricingEntrySchema.parse(data)).toThrow();
    });
  });

  describe('CapacityInfoSchema', () => {
    it('should validate valid capacity info', () => {
      const data = {
        maxConcurrent: 10,
        queueDepth: 100,
      };

      const result = CapacityInfoSchema.parse(data);

      expect(result).toEqual(data);
    });

    it('should allow zero queue depth', () => {
      const data = {
        maxConcurrent: 5,
        queueDepth: 0,
      };

      const result = CapacityInfoSchema.parse(data);

      expect(result.queueDepth).toBe(0);
    });

    it('should reject negative maxConcurrent', () => {
      const data = {
        maxConcurrent: -10,
        queueDepth: 100,
      };

      expect(() => CapacityInfoSchema.parse(data)).toThrow();
    });

    it('should reject zero maxConcurrent', () => {
      const data = {
        maxConcurrent: 0,
        queueDepth: 100,
      };

      expect(() => CapacityInfoSchema.parse(data)).toThrow();
    });

    it('should reject negative queue depth', () => {
      const data = {
        maxConcurrent: 10,
        queueDepth: -100,
      };

      expect(() => CapacityInfoSchema.parse(data)).toThrow();
    });
  });

  describe('AgentCapabilitySchema', () => {
    it('should validate complete capability with all fields', () => {
      const data = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        identifier: 'g.agent.alice',
        supportedKinds: [5000, 5100],
        supportedNips: ['89', '90', 'xx1'],
        agentType: 'dvm',
        ilpAddress: 'g.agent.alice',
        pricing: [
          [5000, { kind: 5000, amount: BigInt(100), currency: 'msat' }],
          [5100, { kind: 5100, amount: BigInt(5000), currency: 'msat' }],
        ],
        capacity: {
          maxConcurrent: 10,
          queueDepth: 100,
        },
        model: 'anthropic:claude-haiku-4-5',
        skills: ['query', 'translate'],
        metadata: {
          name: 'Alice Agent',
          about: 'Finance specialist',
        },
        createdAt: 1234567890,
      };

      const result = AgentCapabilitySchema.parse(data);

      expect(result.pubkey).toBe(data.pubkey);
      expect(result.agentType).toBe('dvm');
      expect(result.pricing).toBeInstanceOf(Map);
      expect(result.pricing.size).toBe(2);
    });

    it('should validate capability with optional fields omitted', () => {
      const data = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        identifier: 'g.agent.bob',
        supportedKinds: [5000],
        supportedNips: ['89'],
        agentType: 'assistant',
        ilpAddress: 'g.agent.bob',
        pricing: [[5000, { kind: 5000, amount: BigInt(50), currency: 'msat' }]],
        metadata: {
          name: 'Bob Agent',
        },
        createdAt: 1234567890,
      };

      const result = AgentCapabilitySchema.parse(data);

      expect(result.capacity).toBeUndefined();
      expect(result.model).toBeUndefined();
      expect(result.skills).toBeUndefined();
    });

    it('should reject invalid pubkey length', () => {
      const data = {
        pubkey: '1234abcd', // Too short
        identifier: 'g.agent.alice',
        supportedKinds: [5000],
        supportedNips: ['89'],
        agentType: 'dvm',
        ilpAddress: 'g.agent.alice',
        pricing: [],
        metadata: {
          name: 'Alice',
        },
        createdAt: 1234567890,
      };

      expect(() => AgentCapabilitySchema.parse(data)).toThrow();
    });

    it('should reject invalid agent type', () => {
      const data = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        identifier: 'g.agent.alice',
        supportedKinds: [5000],
        supportedNips: ['89'],
        agentType: 'invalid-type',
        ilpAddress: 'g.agent.alice',
        pricing: [],
        metadata: {
          name: 'Alice',
        },
        createdAt: 1234567890,
      };

      expect(() => AgentCapabilitySchema.parse(data)).toThrow();
    });

    it('should reject missing required fields', () => {
      const data = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        // Missing identifier, supportedKinds, etc.
        metadata: {
          name: 'Alice',
        },
      };

      expect(() => AgentCapabilitySchema.parse(data)).toThrow();
    });

    it('should reject negative created_at timestamp', () => {
      const data = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        identifier: 'g.agent.alice',
        supportedKinds: [5000],
        supportedNips: ['89'],
        agentType: 'dvm',
        ilpAddress: 'g.agent.alice',
        pricing: [],
        metadata: {
          name: 'Alice',
        },
        createdAt: -1234567890,
      };

      expect(() => AgentCapabilitySchema.parse(data)).toThrow();
    });
  });
});

describe('Validation Helpers', () => {
  describe('validateAgentCapability', () => {
    it('should validate and return valid capability', () => {
      const data = {
        pubkey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        identifier: 'g.agent.alice',
        supportedKinds: [5000],
        supportedNips: ['89'],
        agentType: 'dvm',
        ilpAddress: 'g.agent.alice',
        pricing: [[5000, { kind: 5000, amount: BigInt(100), currency: 'msat' }]],
        metadata: {
          name: 'Alice',
        },
        createdAt: 1234567890,
      };

      const result = validateAgentCapability(data);

      expect(result.pubkey).toBe(data.pubkey);
      expect(result.agentType).toBe('dvm');
    });

    it('should throw error for invalid capability', () => {
      const data = {
        pubkey: 'invalid',
        // Missing required fields
      };

      expect(() => validateAgentCapability(data)).toThrow();
    });
  });

  describe('validateAgentMetadata', () => {
    it('should validate and return valid metadata', () => {
      const data = {
        name: 'Alice Agent',
        about: 'Finance specialist',
      };

      const result = validateAgentMetadata(data);

      expect(result.name).toBe('Alice Agent');
      expect(result.about).toBe('Finance specialist');
    });

    it('should throw error for invalid metadata', () => {
      const data = {
        about: 'Agent without name',
      };

      expect(() => validateAgentMetadata(data)).toThrow();
    });
  });
});
