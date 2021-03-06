const KnownError = require("./error").error
const AWS = require("./aws")
const execa = require("execa")
const Listr = require("listr")
const glob = require("glob")
const fs = require("fs")
const configuration = require("./configuration")
const RoutingRules = require("./routing-rules")
const CacheControl = require("./cache-control")
const mime = require("mime")
const crypto = require("crypto")
const diff = require("./diff")

let loadConfigurationTask = {
  title: "Load configuration",
  task: (context) => {
    let configurationPath = context.configurationPath

    if (!configuration.exists(configurationPath)) {
      throw new KnownError("No configuration file, run `discharge init` first")
    }

    let config = configuration.read(configurationPath)
    let credentials = AWS.credentialsForProfile(config.aws_profile)
    let region = config.aws_region

    context.s3 = AWS.s3({
      credentials: credentials,
      region: region,
    })
    context.config = config
  },
}

let buildWebsiteTask = {
  title: "Build website",
  task: (context) => execa.shell(context.config.build_command),
}

let createBucketTask = {
  title: "Create bucket",
  skip: async (context) => {
    let bucketExists = false

    try {
      bucketExists = await context.s3.headBucket({ Bucket: context.config.domain })
    } catch(error) {}

    if (bucketExists) {
      return "Bucket already exists"
    } else {
      return false
    }
  },
  task: (context) => {
    return context.s3.createBucket({
      ACL: "public-read",
      Bucket: context.config.domain,
    })
  },
}

let configureBucketAsWebsiteTask = {
  title: "Configure bucket as website",
  task: (context) => {
    let indexKey = context.config.index_key
    let errorKey = context.config.error_key

    if (!context.config.trailing_slashes) {
      errorKey = errorKey.replace(".html", "")
    }

    let params = {
      Bucket: context.config.domain,
      WebsiteConfiguration: {
        ErrorDocument: {
          Key: errorKey,
        },
        IndexDocument: {
          Suffix: indexKey,
        },
      },
    }

    if (context.config.redirects || context.config.routing_rules) {
      let routingRules = RoutingRules(context.config.redirects, context.config.routing_rules)
      params.WebsiteConfiguration.RoutingRules = routingRules
    }

    return context.s3.putBucketWebsite(params)
  },
}

let synchronizeWebsiteTask = {
  title: "Synchronize website",
  task: async (context, task) => {
    let domain = context.config.domain
    let uploadDirectory = context.config.upload_directory
    let trailingSlashes = context.config.trailing_slashes

    let targetKey = (path) => {
      if (path != "index.html" && path.endsWith("/index.html") && !trailingSlashes) {
        let directoryName = path.split("/")[0]
        return directoryName
      } else {
        return path
      }
    }

    let paths = glob.sync("**/*", {
      cwd: uploadDirectory,
      nodir: true,
    })

    let cacheControl = CacheControl.build(context.config.cache, context.config.cache_control)

    let source = paths.map((path) => {
      let fullPath = `${uploadDirectory}/${path}`
      let content = fs.readFileSync(fullPath)
      let md5Hash = `"${crypto.createHash("md5").update(content).digest("hex")}"`

      return {
        path: path,
        key: targetKey(path),
        md5Hash: md5Hash,
      }
    })

    let response = await context.s3.listObjectsV2({ Bucket: domain })
    let target = response.Contents.map((object) => {
      return {
        key: object.Key,
        md5Hash: object.ETag,
      }
    })

    let changes = diff({
      source: source,
      target: target,
      locationProperty: "key",
      contentsHashProperty: "md5Hash",
    })

    for (let change of changes.add) {
      task.output = `Adding ${change.path} as ${change.key}`
      let fullPath = `${uploadDirectory}/${change.path}`

      await context.s3.putObject({
        Bucket: domain,
        Body: fs.readFileSync(fullPath),
        Key: change.key,
        ACL: "public-read",
        CacheControl: cacheControl,
        ContentType: mime.getType(fullPath),
      })
    }

    for (let change of changes.update) {
      task.output = `Updating ${change.path} as ${change.key}`
      let fullPath = `${uploadDirectory}/${change.path}`

      await context.s3.putObject({
        Bucket: domain,
        Body: fs.readFileSync(fullPath),
        Key: change.key,
        ACL: "public-read",
        CacheControl: cacheControl,
        ContentType: mime.getType(fullPath),
      })
    }

    for (let change of changes.remove) {
      task.output = `Removing ${change.key}`

      await context.s3.putObject({
        Bucket: domain,
        Key: change.key,
      })
    }
  },
}

module.exports = new Listr([
  loadConfigurationTask,
  buildWebsiteTask,
  createBucketTask,
  configureBucketAsWebsiteTask,
  synchronizeWebsiteTask,
])
