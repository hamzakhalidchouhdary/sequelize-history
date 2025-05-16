'use strict';

const cloneDeep = require('lodash/cloneDeep');
const merge = require('lodash/merge');
const moment = require('moment-timezone');
/**
 * @class
 * SequelizeHistory
 *
 * @classdesc
 * Creates a revision history for instances of a given Sequelize model
 *
 * @constructor
 * @description
 * The constructor parses passed options, attaches hooks
 *
 * @param {object} model - Sequelize model to track
 * @param {object} sequelize - Sequelize object (enforces installation above this module)
 * @param {object} options - Object instantiation options
 * @param {string} options.authorFieldName - String to indicate a field name to store author of the revisions, or null to disable
 * @param {string} options.modelSuffix - String to append to tracked model's name when creating name of tracking model
 * @param {array} options.excludedAttributes - Array of attributes to be ignored and excluded when recording a change to the target model
 * @param {array} options.excludedAttributeProperties - Array of attribute properties to ignore when duplicating the target model's attributes
 * @return {null}
 */
class SequelizeHistory {
	constructor(model, sequelize, options) {
		this.options = Object.assign({},
			SequelizeHistory.DEFAULTS,
			options || {});

		this.model = model;

		// Create name of tracking model by appending
		// suffice option to the tracked model name
		this.modelName = [
			this.model.name,
			this.options.modelSuffix
		].join('');

		// Create the tracking model's schema
		this.fields = this.createSchema(
			sequelize.Sequelize);

		// Register the tracking model with Sequelize
		sequelize.define(
			this.modelName,
			this.setAttributes(),
			{});

		// Store reference to the newly created tracking model
		this.modelHistory = sequelize.models[this.modelName];

		// Add static author tracking method to original model if enabled
		if (typeof this.options.authorFieldName === 'string') {
			this.addModelAuthorSetter(sequelize);

			// Add relationship with the original model to ensure
			// table constraints are not applied if added manually
			this.model.hasMany(this.modelHistory, {
				foreignKey: 'fk_model_id',
				contraints: false,
				as: 'revisions'
			});

			this.modelHistory.belongsTo(this.model, {
				foreignKey: 'fk_model_id',
				contraints: false,
				as: 'model'
			});
		}

		// Setup the necessary hooks for revision tracking
		this.hookup();
	}

	/**
	 * Adds a static `setRevisingAuthor` method to the tracked model if author tracking is enabled.
	 * @private
	 * @param {Sequelize} sequelize - The passed Sequelize instance
	 */
	addModelAuthorSetter(sequelize) {
		const modelName = this.model.name;

		sequelize.models[modelName].setRevisingAuthor = function (value) {
			sequelize.models[modelName]._sequelizeHistoryProps = {
				_authorId: value
			};
		};
	}

	/**
	 * Sets attributes of history model by parsing out target model attributes
	 * @private
	 * @return {object}
	 */
	setAttributes() {
		const cloned = cloneDeep(this.model.rawAttributes);

		const attributes = [];

		return merge({}, this.fields, attributes);
	}

	/**
	 * Creates fields to be added in addition to the tracked model's fields
	 * @private
	 * @return {object} - Model instance field options
	 */
	createSchema(sequelize) {
		const schema = {
			id: {
				type: sequelize.INTEGER,
				autoIncrement: true,
				primaryKey: true,
				unique: true
			},
			modelId: {
				type: sequelize.INTEGER,
				allowNull: true,
				field: 'fk_model_id'
			},
			diff: {
				type: sequelize.TEXT,
				allowNull: true,
				field: 't_diff'
			},
			createdAt: {
				type: sequelize.INTEGER,
				allowNull: false,
				field: 'i_created_at'
			}
		};

		// Add our author tracking field if set
		if (typeof this.options.authorFieldName === 'string') {
			schema[this.options.authorFieldName] = {
				type: sequelize.INTEGER,
				allowNull: true
			};
		}

		return schema;
	}

	/**
	 * Attaches hooks to target model and history model
	 * @private
	 * @return {null}
	 */
	hookup() {
		this.model.addHook('beforeUpdate', this.insertHook.bind(this));
		this.model.addHook('beforeDestroy', this.insertHook.bind(this));
		this.model.addHook('beforeBulkUpdate', this.insertBulkHook.bind(this));
		this.model.addHook('beforeBulkDestroy', this.insertBulkHook.bind(this));
		this.modelHistory.addHook('beforeUpdate', this.readOnlyHook.bind(this));
		this.modelHistory.addHook('beforeDestroy', this.readOnlyHook.bind(this));
	}

	/**
	 * Enforces read-only nature of history model instances
	 * @private
	 * @return {null}
	 */
	readOnlyHook() {
		throw new Error('This is a read-only history database. You cannot modify it.');
	}

	/**
	 * Gets the difference between two objects
	 * @private
	 * @param  {object} previous - previous object
	 * @param  {object} current - current object
	 * @return {object} - object representing the difference
	 * @example
	 * getDifference({a: 1, b: 2}, {a: 1, b: 3}) // {b: 3}
	 * getDifference({a: 1, b: 2}, {a: 1, b: 2}) // {}
	 */
	getDifference(previous, current) {
		const difference = {};
		for (const key in current) {
			if (previous[key] !== current[key] && this.options.excludedAttributes.indexOf(key) === -1){
				difference[key] = previous[key];
			}
		}
		return difference;
	}

	/**
	 * Hook to trigger recording of revision
	 * @private
	 * @param  {Sequelize.Model} doc - instance to track
	 * @param  {object} options - instance options
	 * @return {Sequelize.Model} - Instance representing the revision
	 */
	insertHook(doc, options) {
		const dataValues = doc._previousDataValues || doc.dataValues;

		let historyDataValues = this.getDifference(doc._previousDataValues, doc.dataValues);

		// Grab the static revision author property from the tracked class
		// and null it out after its first use when called via an instance
		if (typeof this.options.authorFieldName === 'string' &&
			typeof this.model._sequelizeHistoryProps !== 'undefined') {
			dataValues[this.options.authorFieldName] = this.model._sequelizeHistoryProps._authorId;
			this.model._sequelizeHistoryProps._authorId = null;
		}

		delete dataValues.id;

		const historyRecord = this.modelHistory.create({
			modelId: doc.dataValues.id,
			diff: JSON.stringify(historyDataValues),
			createdAt: moment().unix(),
			[this.options.authorFieldName]: dataValues[this.options.authorFieldName]
		}, {
			transaction: options.transaction
		});

		return historyRecord;
	}

	/**
	 * Get differenciated object for bulk
	 * @param  {object} object - object to get difference from
	 * @param  {array} fields - fields to get difference for
	 * @return {object} - object representing the difference
	 */

	getDifferenciatedObjectForBulk(object, fields = []) {
		let newObj = {};

		fields.forEach(field => {
			if (this.options.excludedAttributes.indexOf(field) === -1) {
				newObj[field] = object[field];
			}
		});

		return newObj;
	}

	/**
	 * Hook to trigger recording of multiple revision
	 * @param  {object} options - options
	 * @return {Promise} = resolves
	 */
	insertBulkHook(options) {
		if (!options.individualHooks) {
			const queryAll = this.model.findAll({
				where: options.where,
				transaction: options.transaction
			}).then(hits => {
				if (hits !== null) {
					const docs = hits.map(hit => {
						const dataSet = cloneDeep(hit.dataValues);
						const dateSetHistory = this.getDifferenciatedObjectForBulk(dataSet, options.fields);
						// Grab the static revision author property from the tracked class
						if (typeof this.options.authorFieldName === 'string' &&
							typeof this.model._sequelizeHistoryProps !== 'undefined') {
							dataSet[this.options.authorFieldName] = this.model._sequelizeHistoryProps._authorId;
						}

						dataSet.modelId = hit.id;

						return {
							modelId: dataSet.modelId,
							diff: JSON.stringify(dateSetHistory),
							createdAt: moment().unix(),
							[this.options.authorFieldName]: dataSet[this.options.authorFieldName]
						};
					});

					// ...and null it out after all bulk updates are complete
					if (typeof this.options.authorFieldName === 'string' &&
						typeof this.model._sequelizeHistoryProps !== 'undefined') {
						this.model._sequelizeHistoryProps._authorId = null;
					}

					return this.modelHistory.bulkCreate(docs, {
						transaction: options.transaction
					});
				}
			});

			return queryAll;
		}
	}
}

SequelizeHistory.DEFAULTS = {
	// String to indicate a field name to use to store the
	// author of the revisions to the model, or null if you
	// don't want to track revision authors
	authorFieldName: null,
	// String to append to tracked model's name in creating
	// name of model's history model
	modelSuffix: '_history',
	// Array of attributes to be ignored and excluded when
	// recording a change to the target model
	excludedAttributes: [],
	// Array of attribute properties to ignore when duplicating
	// the target model's attributes - this is mostly to prevent
	// the use of constraints that may be in place on the target
	excludedAttributeProperties: [
		'Model',
		'unique',
		'primaryKey',
		'references',
		'onUpdate',
		'onDelete',
		'autoIncrement',
		'set',
		'get',
		'_modelAttribute'
	]
};

/**
 * Factory method for creation without requiring the constructor
 *
 * @module
 * TrackFactory
 *
 * @description
 * Factory method to avoid having to deal with the constructor directly
 * since you're likely applying this to more than one model. All constructor
 * options are passed transparently upon instantiation.
 *
 * @param {object} model - Sequelize model to track
 * @param {object} sequelize - Sequelize object (enforces installation above this module)
 * @param {object} options - Object instantiation options
 * @param {string} options.authorFieldName - String to indicate a field name to store author of the revisions, or null to disable
 * @param {string} options.modelSuffix - String to append to tracked model's name when creating name of tracking model
 * @param {array} options.excludedAttributes - Array of attributes to be ignored and excluded when recording a change to the target model
 * @param {array} options.excludedAttributeProperties - Array of attribute properties to ignore when duplicating the target model's attributes
 * @return {object} - returns the tracked model and generated tracking model
 */
module.exports = (model, sequelize, options) => {
	const instance = new SequelizeHistory(
		model, sequelize, options);

	return instance.modelHistory;
};

/**
 * Factory method to track changes for all sequelize models
 *
 * @module
 * TrackAllFactory
 *
 * @description
 * Convenience factory method to track changes for all models found
 * within the passed sequelize instance. All constructor options
 * are passed transparently upon instantiation.
 *
 * @param {object} sequelize - Sequelize object (enforces installation above this module)
 * @param {object} options - Object instantiation options
 * @param {string} options.authorFieldName - String to indicate a field name to store author of the revisions, or null to disable
 * @param {string} options.modelSuffix - String to append to tracked model's name when creating name of tracking model
 * @param {array} options.excludedAttributes - Array of attributes to be ignored and excluded when recording a change to the target model
 * @param {array} options.excludedAttributeProperties - Array of attribute properties to ignore when duplicating the target model's attributes
 * @return {null}
 */
module.exports.all = (sequelize, options) => {
	const instances = {};
	const names = Object.keys(sequelize.models);

	names.forEach(key => {
		const instance = new SequelizeHistory(
			sequelize.models[key], sequelize, options);

		instances[instance.modelName] = instance;
	});

	return instances;
};

module.exports.SequelizeHistory = SequelizeHistory;
