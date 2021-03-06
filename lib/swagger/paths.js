'use strict'
const Hoek = require('hoek')
const Joi = require('joi')

const Parameters = require('./parameters')
const Definitions = require('./definitions')
const Properties = require('./properties')
const Responses = require('./responses')
const Utilities = require('../utilities')

const internals = {}

exports = module.exports = internals.paths = function (settings) {
  this.settings = settings
  this.definitions = new Definitions(settings)
  this.properties = new Properties(settings, {}, {})
  this.responses = new Responses(settings, {}, {})

  this.defaults = {
    responses: {}
  }

  this.schema = Joi.object({
    tags: Joi.array().items(Joi.string()),
    summary: Joi.string(),
    description: Joi.string(),
    externalDocs: Joi.object({
      description: Joi.string(),
      url: Joi.string().uri()
    }),
    operationId: Joi.string(),
    consumes: Joi.array().items(Joi.string()),
    produces: Joi.array().items(Joi.string()),
    parameters: Joi.array().items(Joi.object()),
    responses: Joi.object().required(),
    schemes: Joi.array().items(Joi.string().valid(['http', 'https', 'ws', 'wss'])),
    deprecated: Joi.boolean(),
    security: Joi.array().items(Joi.object())
  })
}

/**
 * build the swagger path section
 *
 * @param  {Object} routes
 * @return {Object}
 */
internals.paths.prototype.build = function (routes) {
  const routesData = routes.map((route) => {
    let routeData = {
      path: route.path,
      method: route.method.toUpperCase(),
      id: route.id,
      description: route.description,
      summary: route.summary,
      tags: route.tags,
      queryParams: Hoek.reach(route, 'validate.query') || null,
      pathParams: Hoek.reach(route, 'validate.params') || null,
      payloadParams: Hoek.reach(route, 'validate.payload') || null,
      headerParams: Hoek.reach(route, 'validate.headers') || null,
      responseSchema: Hoek.reach(route, 'response.schema'),
      responseStatus: Hoek.reach(route, 'response.status'),
      consumes: route.comsumes || null,
      produces: route.produces || null,
      responses: route.responses || null,
      payloadType: route.payloadType || null,
      security: route.security || null,
      order: route.order || null,
      deprecated: route.deprecated || null,
      groups: route.group
    }

    routeData.path = Utilities.replaceInPath(routeData.path, ['endpoints'], this.settings.pathReplacements)
    // swap out any custom validation function for Joi object/string
    ;[
      'queryParams',
      'pathParams',
      'headerParams',
      'payloadParams'].forEach((property) => {
      // swap out any custom validation function for Joi object/string
        if (Utilities.isFunction(routeData[property])) {
          if (property !== 'pathParams') {
            this.settings.log(['validation', 'warning'], 'Using a Joi.function for a query, header or payload is not supported.')
            if (property === 'payloadParams') {
              routeData[property] = Joi.object().label('Hidden Model')
            } else {
              routeData[property] = Joi.object({ 'Hidden Model': Joi.string() })
            }
          } else {
            this.settings.log(['validation', 'error'], 'Using a Joi.function for a params is not supported and has been removed.')
            routeData[property] = null
          }
        } else {
          routeData[property] = Utilities.toJoiObject(routeData[property])
        }
      })
    return routeData
  })

  return this.buildRoutes(routesData)
}

/**
 * build the swagger path section from hapi routes data
 *
 * @param  {Object} routes
 * @return {Object}
 */
internals.paths.prototype.buildRoutes = function (routes) {
  let pathObj = {}
  let swagger = {
    'definitions': {},
    'x-alt-definitions': {}
  }
  let definitionCache = [
    new WeakMap(),
    new WeakMap()
  ]

  // reset properties
  this.properties = new Properties(this.settings, swagger.definitions, swagger['x-alt-definitions'], definitionCache)
  this.responses = new Responses(this.settings, swagger.definitions, swagger['x-alt-definitions'], definitionCache)

  routes.forEach((route) => {
    let method = route.method
    let out = {
      summary: route.summary,
      operationId: route.id || Utilities.createId(route.method, route.path),
      description: route.description,
      parameters: [],
      consumes: [],
      produces: []
    }
    let path = internals.removeBasePath(route.path, this.settings.basePath, this.settings.pathReplacements)

    // tags in swagger are used for grouping
    out.tags = route.tags || route.groups

    out.description = Array.isArray(route.description) ? route.notes.join('<br/><br/>') : route.description

    if (route.security) {
      out.security = route.security
    }

    // set from plugin options or from route options
    let payloadType = internals.overload(this.settings.payloadType, route.payloadType)

    // build payload either with JSON or form input
    let payloadStructures = this.getDefaultStructures()
    let payloadJoi = internals.getJOIObj(route, 'payloadParams')
    if (payloadType.toLowerCase() === 'json') {
      // set as json
      payloadStructures = this.getSwaggerStructures(payloadJoi, 'body', true, false)
    } else {
      // set as formData
      if (Utilities.hasJoiChildren(payloadJoi)) {
        payloadStructures = this.getSwaggerStructures(payloadJoi, 'formData', false, false)
      } else {
        this.testParameterError(payloadJoi, 'payload form-urlencoded', path)
      }
      // add form data mimetype
      out.consumes = ['application/x-www-form-urlencoded']
    }

    // change form mime-type based on meta property 'swaggerType'
    if (internals.hasFileType(route)) {
      out.consumes = ['multipart/form-data']
    }

    // add user defined over automatically discovered
    if (this.settings.consumes || route.consumes) {
      out.consumes = internals.overload(this.settings.consumes, route.consumes)
    }

    if (this.settings.produces || route.produces) {
      out.produces = internals.overload(this.settings.produces, route.produces)
    }

    // set required true/false for each path params
    let pathStructures = this.getDefaultStructures()
    let pathJoi = internals.getJOIObj(route, 'pathParams')
    if (Utilities.hasJoiChildren(pathJoi)) {
      pathStructures = this.getSwaggerStructures(pathJoi, 'path', false, false)
      pathStructures.parameters.forEach((item) => {
        // add required based on path pattern {prama} and {prama?}
        if (item.required === undefined) {
          // /:item or /:item/
          const regexp = new RegExp(`/:${item.name}($|/)`)
          if (regexp.test(path)) {
            item.required = true
          }
        }
        if (item.required === false) {
          delete item.required
        }
        if (!item.required) {
          this.settings.log(['validation', 'warning'], 'The ' + path + ' params parameter {' + item.name + '} is set as optional. This will work in the UI, but is invalid in the swagger spec')
        }
      })
    } else {
      this.testParameterError(pathJoi, 'params', path)
    }

    // removes ? from {prama?} after we have set required/optional for path params
    // path = internals.cleanPathParameters(path)

    let headerStructures = this.getDefaultStructures()
    let headerJoi = internals.getJOIObj(route, 'headerParams')
    if (Utilities.hasJoiChildren(headerJoi)) {
      headerStructures = this.getSwaggerStructures(headerJoi, 'header', false, false)
    } else {
      this.testParameterError(headerJoi, 'headers', path)
    }
    // if the API has a user set accept header with a enum convert into the produces array
    if (this.settings.acceptToProduce === true) {
      headerStructures.parameters = headerStructures.parameters.filter(function (header) {
        if (header.name.toLowerCase() === 'accept') {
          if (header.enum) {
            out.produces = Utilities.sortFirstItem(header.enum, header.default)
            return false
          }
        }
        return true
      })
    }

    let queryStructures = this.getDefaultStructures()
    let queryJoi = internals.getJOIObj(route, 'queryParams')
    if (Utilities.hasJoiChildren(queryJoi)) {
      queryStructures = this.getSwaggerStructures(queryJoi, 'query', false, false)
    } else {
      this.testParameterError(queryJoi, 'query', path)
    }

    out.parameters = out.parameters.concat(
      headerStructures.parameters,
      pathStructures.parameters,
      queryStructures.parameters,
      payloadStructures.parameters
    )

    // if the api sets the content-type header parameter use that
    if (internals.hasContentTypeHeader(out)) {
      delete out.consumes
    }

    out.responses = this.responses.build(
      route.responses,      // userDefinedSchemas
      route.responseSchema, // defaultSchema
      route.responseStatus, // statusSchemas
      true,                 // useDefinitions
      false                 // isAlt
    )

    if (route.order) {
      out['x-order'] = route.order
    }
    if (route.deprecated !== null) {
      out.deprecated = route.deprecated
    }

    if (!pathObj[path]) {
      pathObj[path] = {}
    }
    pathObj[path][method.toLowerCase()] = Utilities.deleteEmptyProperties(out)
  })

  swagger.paths = pathObj
  return swagger
}

/**
 * gets the JOI object from route object
 *
 * @param  {Object} base
 * @param  {String} name
 * @return {Object}
 */
internals.getJOIObj = function (route, name) {
  return route[name]
}

/**
 * overload one object with another
 *
 * @param  {Object} base
 * @param  {Object} priority
 * @return {Object}
 */
internals.overload = function (base, priority) {
  return priority || base
}

/**
 * does route have property swaggerType of file
 *
 * @param  {Object} route
 * @return {Boolean}
 */
internals.hasFileType = function (route) {
  let routeString = JSON.stringify(Hoek.reach(route, 'payloadParams'))
  return routeString && routeString.indexOf('swaggerType') > -1
}

/**
 * clear path parameters of optional char flag
 *
 * @param  {String} path
 * @return {String}
 */
internals.cleanPathParameters = function (path) {
  return path.replace('?}', '}')
}

/**
 * remove the base path from endpoint
 *
 * @param  {String} path
 * @param  {String} basePath
 * @param  {Array} pathReplacements
 * @return {String}
 */
internals.removeBasePath = function (path, basePath, pathReplacements) {
  if (basePath !== '/' && Utilities.startsWith(path, basePath)) {
    path = path.replace(basePath, '')
    path = Utilities.replaceInPath(path, ['endpoints'], pathReplacements)
  }
  return path
}

/**
 * does path parameters have a content-type header
 *
 * @param  {String} path
 * @return {boolean}
 */
internals.hasContentTypeHeader = function (path) {
  let out = false
  path.parameters.forEach(function (param) {
    if (param.in === 'header' && param.name.toLowerCase() === 'content-type') {
      out = true
    }
  })
  return out
}

/**
 * builds an object containing different swagger structures that can be use to represent one object
 *
 * @param  {Object} joiObj
 * @param  {String} parameterType
 * @param  {Boolean} useDefinitions
 * @param  {Boolean} isAlt
 * @return {Object}
 */
internals.paths.prototype.getSwaggerStructures = function (joiObj, parameterType, useDefinitions, isAlt) {
  let outProperties
  let outParameters

  if (joiObj) {
    // name, joiObj, parent, parameterType, useDefinitions, isAlt
    outProperties = this.properties.parseProperty(null, joiObj, null, parameterType, useDefinitions, isAlt)
    outParameters = Parameters.fromProperties(outProperties, parameterType)
  }
  return {
    properties: outProperties || {},
    parameters: outParameters || []
  }
}

internals.paths.prototype.getDefaultStructures = function () {
  return {
    'properties': {},
    'parameters': []
  }
}

internals.paths.prototype.testParameterError = function (joiObj, parameterType, path) {
  if (joiObj && !Utilities.hasJoiChildren(joiObj)) {
    this.settings.log(['validation', 'error'], 'The ' + path + ' route ' + parameterType + ' parameter was set, but not as a Joi.object() with child properties')
  }
}
