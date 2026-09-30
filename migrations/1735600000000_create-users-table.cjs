/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('users', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()')
    },
    github_id: {
      type: 'bigint',
      notNull: false,
      unique: true
    },
    github_login: {
      type: 'text',
      notNull: false
    },
    avatar_url: {
      type: 'text',
      notNull: false
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()')
    },
    last_login_at: {
      type: 'timestamptz',
      notNull: false
    }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('users');
};
