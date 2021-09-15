'use strict'
const { sign_txn } = require('eos-ecc')
const {
  GraphQLList,
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLError
} = require('graphql')
const authorization_type = require('../../eos_types/authorization_type')
const {
  transaction_receipt_type,
  packed_transaction_type
} = require('../../eos_types/mutation_types')
const get_block = require('../../network/get_block.js')
const get_info = require('../../network/get_info.js')
const get_required_keys = require('../../network/get_required_keys')
const push_transaction = require('../../network/push_transaction.js')
const serialize_actions = require('../../wasm/serialize/actions.js')
const serialize_extensions = require('../../wasm/serialize/extension.js')
const serialize_header = require('../../wasm/serialize/transaction_header.js')
const abi_to_ast = require('../abi_to_ast/index.js.js')
const { configuration, defaultValue } = require('./configuration')
const serialize_transaction_data = require('./serialize_transaction_data.js')

/**
 * This function builds mutation fields of a GraphQL query of the Schema from an ABI of a given EOS smart contract.
 * @name build_mutation_fields
 * @kind function
 * @param {object} ABI ABI for a smart contract.
 * @param {bool} broadcast Push the transaction to blockchain, else return serialized transaction.
 * @returns {object} GraphQL mutation fields.
 * @ignore
 */
function build_mutation_fields(ABI, broadcast) {
  const { ast_input_object_types, abi_ast } = abi_to_ast(ABI)

  const fields = ABI.actions.reduce(
    (acc, { name, type, ricardian_contract }) => ({
      ...acc,
      [name]: {
        description: (() => {
          let description = ricardian_contract.match(/^title: .+$/gmu)
          if (description) return description[0].replace('title: ', '')
          return ''
        })(),
        type: new GraphQLInputObjectType({
          name: `${name}_data`,
          fields: () => ({
            ...(() => {
              if (Object.keys(ast_input_object_types[type]._fields()).length)
                return ast_input_object_types[type]._fields()
            })(),
            authorization: {
              description: 'Authorization array object.',
              type: new GraphQLNonNull(new GraphQLList(authorization_type))
            }
          })
        })
      }
    }),
    {}
  )

  return {
    transaction: {
      type: broadcast ? transaction_receipt_type : packed_transaction_type,
      description: `
This mutation allows you to perform atomic actions (i.e. indivisible and irreducible series of transactions) such that all occur or none occur.
_Actions (i.e. transaction arguments) will be executed from top to bottom._

---

`,
      args: {
        actions: {
          type: GraphQLNonNull(
            new GraphQLList(
              GraphQLNonNull(
                new GraphQLInputObjectType({
                  name: 'action_type',
                  description: 'List of the smart contract actions.',
                  fields
                })
              )
            )
          )
        },
        configuration: {
          type: configuration,
          defaultValue
        }
      },
      async resolve(
        _,
        { configuration, actions },
        { contract, rpc_url, key_chain = [] }
      ) {
        const context_free_actions = []
        const transaction_extensions = []

        let action_array = []
        // create a list of transaction actions
        for await (const action of actions)
          action_array.push(
            ...(await Promise.all(
              Object.keys(action).map(async actionType => {
                const { authorization, ...data } = action[actionType]
                return {
                  account: contract,
                  action: actionType,
                  authorization,
                  data: await serialize_transaction_data({
                    actionType,
                    data,
                    abi_ast
                  })
                }
              })
            ))
          )

        // EOS transaction body
        const transaction_body =
          serialize_actions(context_free_actions) +
          serialize_actions(action_array) +
          serialize_extensions(transaction_extensions) +
          '0000000000000000000000000000000000000000000000000000000000000000'

        const { chain_id, head_block_num } = await get_info({ rpc_url })
        const block_num_or_id = head_block_num - configuration.blocksBehind
        const { timestamp, block_num, ref_block_prefix } = await get_block({
          rpc_url,
          block_num_or_id
        })

        // TaPoS expiry time.
        const expiration =
          Math.round(Date.parse(timestamp + 'Z') / 1000) +
          configuration.expireSeconds

        // Generates a transaction header for a EOS transaction.
        const transaction_header = serialize_header({
          expiration,
          ref_block_num: block_num & 0xffff,
          ref_block_prefix,
          max_net_usage_words: configuration.max_net_usage_words,
          max_cpu_usage_ms: configuration.max_cpu_usage_ms,
          delay_sec: configuration.delay_sec
        })

        if (!broadcast)
          return {
            chain_id,
            transaction_header,
            transaction_body
          }

        const { required_keys, error } = await get_required_keys({
          rpc_url,
          transaction: {
            expiration: new Date(expiration).toISOString().split('.')[0],
            ref_block_num: block_num & 0xffff,
            ref_block_prefix,
            max_net_usage_words: configuration.max_net_usage_words,
            max_cpu_usage_ms: configuration.max_cpu_usage_ms,
            delay_sec: configuration.delay_sec,
            context_free_actions,
            transaction_extensions,
            actions: action_array.map(({ action, ...data }) => ({
              name: action,
              ...data
            }))
          },
          available_keys: key_chain.map(({ public_key }) => public_key)
        })

        if (error) throw new GraphQLError(error)

        // Generate sigs
        const signatures = await Promise.all(
          required_keys.map(key => {
            return sign_txn({
              hex: chain_id + transaction_header + transaction_body,
              wif_private_key: key_chain.find(
                ({ public_key }) => key == public_key
              ).private_key
            })
          })
        )

        const receipt = await push_transaction({
          transaction: transaction_header + transaction_body,
          signatures,
          rpc_url
        })

        if (receipt.error) throw new GraphQLError(receipt.error)

        return receipt
      }
    }
  }
}

module.exports = build_mutation_fields
