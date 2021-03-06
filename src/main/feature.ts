import fs from "fs";
import path from "path"
import hb from "handlebars"
import { ResourceApplier } from "./resource-applier"
import { CoreV1Api, KubeConfig, Watch } from "@kubernetes/client-node"
import { Cluster } from "./cluster";
import logger from "./logger";
import { isDevelopment } from "../common/vars";

export type FeatureStatusMap = Record<string, FeatureStatus>
export type FeatureMap = Record<string, Feature>

export interface FeatureInstallRequest {
  clusterId: string;
  name: string;
  config?: any;
}

export interface FeatureStatus {
  currentVersion: string;
  installed: boolean;
  latestVersion: string;
  canUpgrade: boolean;
}

export abstract class Feature {
  public name: string;
  public latestVersion: string;

  abstract async upgrade(cluster: Cluster): Promise<void>;

  abstract async uninstall(cluster: Cluster): Promise<void>;

  abstract async featureStatus(kc: KubeConfig): Promise<FeatureStatus>;

  constructor(public config: any) {
  }

  get folderPath() {
    if (isDevelopment) {
      return path.resolve(__static, "../src/features", this.name);
    }
    return path.resolve(__static, "../features", this.name);
  }

  async install(cluster: Cluster): Promise<void> {
    const resources = this.renderTemplates();
    try {
      await new ResourceApplier(cluster).kubectlApplyAll(resources);
    } catch (err) {
      logger.error("Installing feature error", { err, cluster });
      throw err;
    }
  }

  protected async deleteNamespace(kc: KubeConfig, name: string) {
    return new Promise(async (resolve, reject) => {
      const client = kc.makeApiClient(CoreV1Api)
      const result = await client.deleteNamespace("lens-metrics", 'false', undefined, undefined, undefined, "Foreground");
      const nsVersion = result.body.metadata.resourceVersion;
      const nsWatch = new Watch(kc);
      const query: Record<string, string> = {
        resourceVersion: nsVersion,
        fieldSelector: "metadata.name=lens-metrics",
      }
      const req = await nsWatch.watch('/api/v1/namespaces', query,
        (phase, obj) => {
          if (phase === 'DELETED') {
            logger.debug(`namespace ${name} finally gone`)
            req.abort();
            resolve()
          }
        },
        (err?: any) => {
          if (err) reject(err);
        });
    });
  }

  protected renderTemplates(): string[] {
    const folderPath = this.folderPath;
    const resources: string[] = [];
    logger.info(`[FEATURE]: render templates from ${folderPath}`);
    fs.readdirSync(folderPath).forEach(filename => {
      const file = path.join(folderPath, filename);
      const raw = fs.readFileSync(file);
      if (filename.endsWith('.hb')) {
        const template = hb.compile(raw.toString());
        resources.push(template(this.config));
      } else {
        resources.push(raw.toString());
      }
    });

    return resources;
  }
}
