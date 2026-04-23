// Deployment status state machine
export type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed';

// Source type for deployments
export type DeploymentSourceType = 'git' | 'upload';

// Log event stage
export type LogStage = 'build' | 'deploy' | 'system';

// Core Deployment resource
export interface Deployment {
  id: string;
  sourceType: DeploymentSourceType;
  sourceRef: string; // git URL or uploaded artifact ref
  status: DeploymentStatus;
  imageTag?: string;
  containerId?: string;
  routePath?: string;
  liveUrl?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// Deployment log event
export interface DeploymentLogEvent {
  id: string;
  deploymentId: string;
  stage: LogStage;
  message: string;
  timestamp: string; // ISO 8601
  sequence: number;
}

// API Request/Response types
export interface CreateDeploymentRequest {
  gitUrl?: string;
  archive?: FormData; // For file uploads
}

export interface CreateDeploymentResponse {
  deployment: Deployment;
}

export interface ListDeploymentsResponse {
  deployments: Deployment[];
}

export interface GetDeploymentResponse {
  deployment: Deployment;
}

export interface StreamLogsResponse {
  events: DeploymentLogEvent[];
}

// SSE Log Event for streaming
export interface SSELogEvent {
  type: 'log';
  data: DeploymentLogEvent;
}

export interface SSEStatusEvent {
  type: 'status';
  data: {
    deploymentId: string;
    status: DeploymentStatus;
  };
}

export type SSEMessage = SSELogEvent | SSEStatusEvent;
