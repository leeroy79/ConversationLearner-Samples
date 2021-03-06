/**
 * Copyright (c) Microsoft Corporation. All rights reserved.  
 * Licensed under the MIT License.
 */
import * as path from 'path'
import * as express from 'express'
import * as BB from 'botbuilder'
import { BotFrameworkAdapter } from 'botbuilder'
import { ConversationLearner, ClientMemoryManager, FileStorage, SessionEndState } from '@conversationlearner/sdk'
import config from '../config'
import startDol from '../dol'

//===================
// Create Bot server
//===================
const server = express()

const isDevelopment = process.env.NODE_ENV === 'development'
if (isDevelopment) {
    startDol(server, config.botPort)
}
else {
    const listener = server.listen(config.botPort, () => {
        console.log(`Server listening to ${listener.address().port}`)
    })
}

const { bfAppId, bfAppPassword, modelId, ...clOptions } = config

//==================
// Create Adapter
//==================
const adapter = new BotFrameworkAdapter({ appId: bfAppId, appPassword: bfAppPassword });

//==================================
// Storage 
//==================================
// Initialize ConversationLearner using file storage.  
// Recommended only for development
// See "storageDemo.ts" for other storage options
let fileStorage = new FileStorage(path.join(__dirname, 'storage'))

//==================================
// Initialize Conversation Learner
//==================================
const sdkRouter = ConversationLearner.Init(clOptions, fileStorage)
if (isDevelopment) {
    server.use('/sdk', sdkRouter)
}
let cl = new ConversationLearner(modelId);

//==================================
// Add Start / End Session callbacks
//==================================
/**
* Called at session start.
* Allows bot to set initial entities before conversation begins
* @param {BB.TurnContext} context Allows retrieval of Bot State
* @param {ClientMemoryManager} memoryManager Allows for viewing and manipulating Bot's memory
* @returns {Promise<void>}
*/
cl.OnSessionStartCallback(async (context: BB.TurnContext, memoryManager: ClientMemoryManager): Promise<void> => {
    // Initialize ConversationLearner Entity from Bot State
    let state = convoState.get(context)
    if (state && state.storeIsOpen) {
        memoryManager.RememberEntity("isOpen", state.storeIsOpen)
    }
})

let state: any = null

/**
* Called when Session ends.
* If not implemented all entity values will be cleared
* If implemented, developer can copy entites from Prev to preserve them for the next session 
* as well as store them in the Bot State
* @param {BB.TurnContext} context Allows retrieval of Bot State
* @param {ClientMemoryManager} memoryManager Allows for viewing and manipulating Bot's memory
* @param {string | undefined} data Value set in End_Session Action in UI
* @returns {Promise<string[] | undefined>} List of Entity values to preserve after session End
*/
cl.OnSessionEndCallback(async (context: BB.TurnContext, memoryManager: ClientMemoryManager, sessionEndState: SessionEndState, data: string | undefined) => {
    let state = convoState.get(context)
    if (!state) throw("Bot State not Initialized!")

    // Update Bot State to indicate ConversationLearner should no longer be in control
    state.usingConversationLearner = false

    // If END_SESSION action was called
    if (sessionEndState === SessionEndState.COMPLETED) {

        await context.sendActivity(`Thanks for shopping.`)

        // 1) Do something with returned "data" defined in EndSession action
        //    It could, for example, specify things such as: Was the task
        //    was successfully completed?  Is there a need to escale to a human?

        // 2) Extract values from ConversationLearner memoryManager and store in BotState
        state.purchasedItem = memoryManager.PrevEntityValue("purchaseItem")

        // 3) Return list of Entities to save for the next time ConversationLearner is started
        //    (see tutorialSessionCallback for an example)
    }
})

// All transfer of state between the global Bot’s state and Conversation Learner 
// must happen in the “onSessionStart” and “onSessionEnd” callbacks.  This is to
// ensure that Conversation Learner has the context that it needs to choose the which Actions to select
cl.AddAPICallback("BadCallback", async (memoryManager: ClientMemoryManager) => {

    // WRONG:
    // Never transfer state in an API callback 
    // convoState.someVar = memoryManager.EntityValue("someEntity")
    
    // WRONG:
    // Never transfer state in an API callback 
    // memoryManager.RememberEntity("someEntity", convoState.someVal)
})

// Add state middleware
const storage = new BB.MemoryStorage();
const convoState = new BB.ConversationState(storage);
adapter.use(new BB.BotStateSet(convoState));


//=================================
// Handle Incoming Messages
//=================================
server.post('/api/messages', (req, res) => {
    adapter.processActivity(req, res, async context => {

        // Get BotBuilder state
        // -> state.usingConversationLearner    : whether ConversationLearner is in control of Bot
        // -> state.storeIsOpen                 : whether store front is open (set outside Conversation Learner)
        // -> state.purchasedItem               : what to buy.  Retreived from ConversationLearner when EndSession is triggered

        state = convoState.get(context)
        if (!state) throw ('Error Getting State');

        // When running in training UI, ConversationLearner must always have control
        // Could be combined with 2nd if, but keeping separate for demo clarity
        if (cl.inTrainingUI(context)) {
            let result = await cl.recognize(context)
            if (result) {
                cl.SendResult(result);
            }
        }

        // Will be true if user said "shop" (see below)
        else if (state.usingConversationLearner) {
            let result = await cl.recognize(context)
            if (result) {
                cl.SendResult(result);
            }
        }

        // Handle message in some other way outside ConversationLearner 
        // (this could be LUIS or even another instance of ConversationLearner with a different skill)
        else {

            if (context.activity.type === 'message') {

                // Set a state variable (storeIsOpen) that will be used later
                // to initialize conversationLearner in OnSessionStartCallback
                if (context.activity.text === 'open store') {
                    state.storeIsOpen = true;
                    await context.sendActivity(`Store is OPEN!`)
                }
                else if (context.activity.text === 'close store') {
                    state.storeIsOpen = false;
                    await context.sendActivity(`Store is CLOSED!`)
                }

                // User input that triggers use of ConversationLearner
                else if (context.activity.text === 'shop')
                {
                    state.usingConversationLearner = true;

                    // StartSession triggers "OnSessionStartCallback" which initializes ConversationLearner.  
                    await cl.StartSession(context)
                    await context.sendActivity(`Let's shop!`)
                }

                // If I have a purchasedItem show it.  Purchased item is returned by ConversationLearner
                // and stored in the onSessionEnd callback
                else if (context.activity.text === 'history') {
                    await context.sendActivity(`You bought ${state.purchasedItem ? state.purchasedItem : "nothing"}`)
                }
                
                // Otherwise show commands
                else {
                    await context.sendActivity(`You can: "open store", "close store", "shop", "history"`)
                }
            }
        }
    })
})


