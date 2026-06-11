CREATE USER n8n WITH PASSWORD 'n8n_dev_password';

CREATE DATABASE n8n OWNER n8n;

\connect n8n

GRANT ALL ON SCHEMA public TO n8n;

\connect servicedesk

CREATE EXTENSION IF NOT EXISTS vector;
