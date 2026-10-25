import { NextResponse } from 'next/server'

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Ricotdin API',
    version: '1.0.0',
    description:
      'Meeting assistant API — recording, transcription, RAG chatbot, todos, and admin management.',
  },
  servers: [{ url: '/api', description: 'Current host' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Supabase access token obtained from /api/auth/login',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
      Meeting: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          title: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['pending', 'processing', 'done', 'failed'] },
          audio_path: { type: 'string', nullable: true },
          audio_purged_at: { type: 'string', format: 'date-time', nullable: true },
          summary: { type: 'string', nullable: true },
          notes: { type: 'string', nullable: true },
          language: { type: 'string', nullable: true },
          error_message: { type: 'string', nullable: true },
          pinned_at: { type: 'string', format: 'date-time', nullable: true },
          folder_id: { type: 'string', format: 'uuid', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      Folder: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          position: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      FolderShare: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', format: 'uuid' },
          grantee_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['viewer', 'editor'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Todo: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          meeting_id: { type: 'string', format: 'uuid' },
          text: { type: 'string' },
          done: { type: 'boolean' },
          status: { type: 'string', enum: ['active', 'dismissed'] },
          due_date: { type: 'string', format: 'date', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      CalendarSuggestion: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          meeting_id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          proposed_at: { type: 'string', format: 'date-time', nullable: true },
          status: { type: 'string', enum: ['active', 'dismissed'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AdminUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email', nullable: true },
          username: { type: 'string', nullable: true },
          role: { type: 'string', enum: ['user', 'admin'] },
          disabled: { type: 'boolean' },
          meeting_count: { type: 'integer' },
          last_sign_in_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AuditLog: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          actor_id: { type: 'string', format: 'uuid' },
          actor_email: { type: 'string', nullable: true },
          action: { type: 'string' },
          target_type: { type: 'string', nullable: true },
          target_id: { type: 'string', nullable: true },
          metadata: { type: 'object', nullable: true },
          ip_address: { type: 'string', nullable: true },
          user_agent: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  tags: [
    { name: 'Auth', description: 'Registration and login' },
    { name: 'Meetings', description: 'Meeting lifecycle — create, process, manage' },
    { name: 'Folders', description: 'Folder organisation and sharing' },
    { name: 'Todos', description: 'Meeting to-do items' },
    { name: 'Calendar', description: 'Calendar suggestions extracted from meetings' },
    { name: 'Chat', description: 'RAG chatbot over meeting transcripts' },
    { name: 'Audio', description: 'Signed audio playback URLs' },
    { name: 'Admin — Users', description: 'User management (admin only)' },
    { name: 'Admin — Pipeline', description: 'Pipeline monitoring and job requeue (admin only)' },
    { name: 'Admin — Usage', description: 'AI provider usage tracking (admin only)' },
    { name: 'Admin — System', description: 'Health, storage, config, audit logs (admin only)' },
  ],
  paths: {
    // ── Auth ────────────────────────────────────────────────────────────────────
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new account',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'username', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  username: { type: 'string', minLength: 3, maxLength: 30 },
                  password: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Account created — email verification may be required',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { needsVerification: { type: 'boolean' } },
                },
              },
            },
          },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Email or username already taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with email or username',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['identifier', 'password'],
                properties: {
                  identifier: { type: 'string', description: 'Email address or username' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Session tokens',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    access_token: { type: 'string' },
                    refresh_token: { type: 'string' },
                  },
                },
              },
            },
          },
          400: { description: 'Missing fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Meetings ────────────────────────────────────────────────────────────────
    '/meetings': {
      post: {
        tags: ['Meetings'],
        summary: 'Create a meeting and get a presigned upload URL',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['filename', 'contentType'],
                properties: {
                  filename: { type: 'string' },
                  contentType: { type: 'string', example: 'audio/webm' },
                  title: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Meeting row created with signed upload URL',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    meetingId: { type: 'string', format: 'uuid' },
                    uploadUrl: { type: 'string', format: 'uri' },
                    audioPath: { type: 'string' },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/meetings/{id}': {
      patch: {
        tags: ['Meetings'],
        summary: 'Rename a meeting',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: { title: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated meeting', content: { 'application/json': { schema: { $ref: '#/components/schemas/Meeting' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Meetings'],
        summary: 'Delete a meeting and its audio file',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Deleted. Optional storage warning if audio removal failed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    warning: { type: 'string' },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/meetings/{id}/uploaded': {
      post: {
        tags: ['Meetings'],
        summary: 'Notify server that audio upload is complete — triggers processing pipeline',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Processing started', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } },
          404: { description: 'Meeting not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/meetings/{id}/process': {
      post: {
        tags: ['Meetings'],
        summary: 'Manually trigger the processing pipeline for a meeting',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Pipeline triggered', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/meetings/{id}/pin': {
      patch: {
        tags: ['Meetings'],
        summary: 'Toggle pin on a meeting',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['pinned'],
                properties: { pinned: { type: 'boolean' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated pin state', content: { 'application/json': { schema: { $ref: '#/components/schemas/Meeting' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/meetings/{id}/regenerate': {
      post: {
        tags: ['Meetings'],
        summary: 'Re-run the AI analysis on an already-transcribed meeting',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Regeneration started' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Folders ─────────────────────────────────────────────────────────────────
    '/folders': {
      get: {
        tags: ['Folders'],
        summary: 'List folders owned by or shared with the current user',
        responses: {
          200: {
            description: 'Folder list',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Folder' } },
              },
            },
          },
        },
      },
      post: {
        tags: ['Folders'],
        summary: 'Create a new folder',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Created folder', content: { 'application/json': { schema: { $ref: '#/components/schemas/Folder' } } } },
          409: { description: 'Name already exists for this user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/folders/{id}': {
      patch: {
        tags: ['Folders'],
        summary: 'Rename a folder',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated folder', content: { 'application/json': { schema: { $ref: '#/components/schemas/Folder' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Folders'],
        summary: 'Delete a folder (meetings are unassigned, not deleted)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Deleted' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/folders/reorder': {
      put: {
        tags: ['Folders'],
        summary: 'Update folder positions for drag-and-drop ordering',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['order'],
                properties: {
                  order: {
                    type: 'array',
                    items: { type: 'string', format: 'uuid' },
                    description: 'Folder IDs in desired display order',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Positions updated' },
          400: { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/folders/{id}/shares': {
      get: {
        tags: ['Folders'],
        summary: 'List shares for a folder',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Share list',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/FolderShare' } },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Folders'],
        summary: 'Share a folder with another user',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['granteeId', 'role'],
                properties: {
                  granteeId: { type: 'string', format: 'uuid' },
                  role: { type: 'string', enum: ['viewer', 'editor'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Share created', content: { 'application/json': { schema: { $ref: '#/components/schemas/FolderShare' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/folders/{id}/shares/{granteeId}': {
      patch: {
        tags: ['Folders'],
        summary: "Update a share's role",
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'granteeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role'],
                properties: { role: { type: 'string', enum: ['viewer', 'editor'] } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated share', content: { 'application/json': { schema: { $ref: '#/components/schemas/FolderShare' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Folders'],
        summary: 'Revoke a share',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'granteeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Revoked' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Todos ───────────────────────────────────────────────────────────────────
    '/todos/{id}': {
      patch: {
        tags: ['Todos'],
        summary: 'Update a todo (done state or dismiss)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  done: { type: 'boolean' },
                  status: { type: 'string', enum: ['active', 'dismissed'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated todo', content: { 'application/json': { schema: { $ref: '#/components/schemas/Todo' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Calendar ────────────────────────────────────────────────────────────────
    '/calendar-suggestions/{id}': {
      patch: {
        tags: ['Calendar'],
        summary: 'Dismiss a calendar suggestion',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['active', 'dismissed'] } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated suggestion', content: { 'application/json': { schema: { $ref: '#/components/schemas/CalendarSuggestion' } } } },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/calendar-suggestions/{id}/ics': {
      get: {
        tags: ['Calendar'],
        summary: 'Download a calendar suggestion as an .ics file',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'ICS file',
            content: { 'text/calendar': { schema: { type: 'string' } } },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          422: { description: 'No proposed_at date — cannot generate ICS', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Chat ────────────────────────────────────────────────────────────────────
    '/chat': {
      post: {
        tags: ['Chat'],
        summary: 'Send a message to the RAG chatbot',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  message: { type: 'string' },
                  meetingId: { type: 'string', format: 'uuid', description: 'Scope chat to a single meeting. Omit for cross-meeting chat.' },
                  sessionId: { type: 'string', format: 'uuid', description: 'Resume an existing chat session.' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Grounded answer with citations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    answer: { type: 'string' },
                    sessionId: { type: 'string', format: 'uuid' },
                    citations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          chunk_id: { type: 'string' },
                          text: { type: 'string' },
                          start_seconds: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: 'Unauthenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Audio ───────────────────────────────────────────────────────────────────
    '/audio-url/{id}': {
      get: {
        tags: ['Audio'],
        summary: 'Get a short-lived signed URL for streaming meeting audio',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Signed URL (valid ~60 s)',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' } } },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Users (non-admin) ───────────────────────────────────────────────────────
    '/users/lookup': {
      post: {
        tags: ['Folders'],
        summary: 'Look up a user by email or username (for share UI)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                  username: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Matched user',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    email: { type: 'string' },
                    username: { type: 'string' },
                  },
                },
              },
            },
          },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin — Users ───────────────────────────────────────────────────────────
    '/admin/users': {
      get: {
        tags: ['Admin — Users'],
        summary: 'List all users (paginated)',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'perPage', in: 'query', schema: { type: 'integer', default: 20, maximum: 1000 } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Filter by email or username' },
        ],
        responses: {
          200: {
            description: 'Paginated user list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    users: { type: 'array', items: { $ref: '#/components/schemas/AdminUser' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Not an admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/users/{id}': {
      delete: {
        tags: ['Admin — Users'],
        summary: 'Delete a user, their meetings, and their audio files',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Deleted. storageWarnings lists any audio files that could not be removed.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    storageWarnings: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/users/{id}/role': {
      patch: {
        tags: ['Admin — Users'],
        summary: "Change a user's role",
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role'],
                properties: { role: { type: 'string', enum: ['user', 'admin'] } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Role updated' },
          403: { description: 'Forbidden or last-admin guard', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/users/{id}/status': {
      patch: {
        tags: ['Admin — Users'],
        summary: 'Enable or disable a user account',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['disabled'],
                properties: { disabled: { type: 'boolean' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Status updated' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/users/{id}/reset-password': {
      post: {
        tags: ['Admin — Users'],
        summary: 'Send a password-recovery email to a user',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Recovery email sent' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/users/bulk': {
      post: {
        tags: ['Admin — Users'],
        summary: 'Apply an action to multiple users at once',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ids', 'action'],
                properties: {
                  ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
                  action: { type: 'string', enum: ['disable', 'enable', 'set_role'] },
                  role: { type: 'string', enum: ['user', 'admin'], description: 'Required when action=set_role' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Bulk result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    processed: { type: 'integer' },
                    skippedSelf: { type: 'array', items: { type: 'string' } },
                    errors: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          message: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin — Pipeline ────────────────────────────────────────────────────────
    '/admin/pipeline/overview': {
      get: {
        tags: ['Admin — Pipeline'],
        summary: 'Aggregate pipeline counts and average processing time',
        responses: {
          200: {
            description: 'Pipeline overview',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    counts: {
                      type: 'object',
                      properties: {
                        pending:    { type: 'integer' },
                        processing: { type: 'integer' },
                        done:       { type: 'integer' },
                        failed:     { type: 'integer' },
                        stuck:      { type: 'integer' },
                      },
                    },
                    avg_processing_secs: { type: 'number', nullable: true },
                    stuck_threshold_minutes: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/pipeline/jobs': {
      get: {
        tags: ['Admin — Pipeline'],
        summary: 'Paginated list of pipeline jobs with metadata only (no transcript content)',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'done', 'failed', 'stuck'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'perPage', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: {
          200: {
            description: 'Job list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jobs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          title: { type: 'string', nullable: true },
                          status: { type: 'string' },
                          created_at: { type: 'string', format: 'date-time' },
                          updated_at: { type: 'string', format: 'date-time' },
                          duration_seconds: { type: 'number', nullable: true },
                          error_message: { type: 'string', nullable: true },
                          owner_email: { type: 'string', nullable: true },
                          owner_username: { type: 'string', nullable: true },
                        },
                      },
                    },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/pipeline/{id}/requeue': {
      post: {
        tags: ['Admin — Pipeline'],
        summary: 'Re-run a failed or stuck meeting through the pipeline',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Requeued — pipeline running in background' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          422: { description: 'Meeting is not in a requeueable state (pending or done)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin — Usage ───────────────────────────────────────────────────────────
    '/admin/ai-usage': {
      get: {
        tags: ['Admin — Usage'],
        summary: 'AI provider usage aggregated by provider/model/unit',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Start of window (default: 30 days ago)' },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'End of window (default: now)' },
          { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['operation'] }, description: 'Further split rows by operation' },
        ],
        responses: {
          200: {
            description: 'Usage report',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                    rows: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          provider: { type: 'string' },
                          model: { type: 'string' },
                          operation: { type: 'string' },
                          unit: { type: 'string', enum: ['tokens', 'audio_seconds'] },
                          calls: { type: 'integer' },
                          total_tokens: { type: 'integer', nullable: true },
                          total_input_tokens: { type: 'integer', nullable: true },
                          total_output_tokens: { type: 'integer', nullable: true },
                          total_audio_seconds: { type: 'number', nullable: true },
                          rate_limited_count: { type: 'integer' },
                          error_count: { type: 'integer' },
                        },
                      },
                    },
                    dailyTotals: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          date: { type: 'string', format: 'date' },
                          provider: { type: 'string' },
                          unit: { type: 'string' },
                          quantity: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Admin — System ──────────────────────────────────────────────────────────
    '/admin/health': {
      get: {
        tags: ['Admin — System'],
        summary: 'Check connectivity to Supabase and AI providers',
        responses: {
          200: {
            description: 'Health status of all services',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    supabase: { type: 'string', enum: ['ok', 'error'] },
                    gemini: { type: 'string', enum: ['ok', 'error'] },
                    speechmatics: { type: 'string', enum: ['ok', 'error'] },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/audit-logs': {
      get: {
        tags: ['Admin — System'],
        summary: 'Paginated audit log',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'perPage', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'action', in: 'query', schema: { type: 'string' }, description: 'Filter by action name' },
        ],
        responses: {
          200: {
            description: 'Audit log entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    logs: { type: 'array', items: { $ref: '#/components/schemas/AuditLog' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/storage/orphans': {
      get: {
        tags: ['Admin — System'],
        summary: 'List Storage objects with no corresponding meetings row',
        responses: {
          200: {
            description: 'Orphan file list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    orphans: { type: 'array', items: { type: 'string' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/storage/cleanup': {
      post: {
        tags: ['Admin — System'],
        summary: 'Delete orphaned Storage objects',
        responses: {
          200: {
            description: 'Cleanup result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    deleted: { type: 'integer' },
                    errors: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/config': {
      get: {
        tags: ['Admin — System'],
        summary: 'Get all runtime config entries',
        responses: {
          200: {
            description: 'Config key-value pairs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
            },
          },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/config/{key}': {
      patch: {
        tags: ['Admin — System'],
        summary: 'Update a runtime config value',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['value'],
                properties: { value: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Config updated' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/keys': {
      get: {
        tags: ['Admin — System'],
        summary: 'List API keys',
        responses: {
          200: { description: 'Key list' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Admin — System'],
        summary: 'Create a new API key',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Created key (secret shown once)' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/keys/{id}': {
      patch: {
        tags: ['Admin — System'],
        summary: 'Rename or disable an API key',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Updated key' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Admin — System'],
        summary: 'Revoke an API key',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Revoked' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/usage': {
      get: {
        tags: ['Admin — Usage'],
        summary: 'General usage stats (meetings, storage)',
        responses: {
          200: { description: 'Usage stats' },
          403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
}

export function GET() {
  return NextResponse.json(spec, {
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
}
