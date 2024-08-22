(ns instant.stripe
  (:require
   [instant.config :as config]
   [ring.util.http-response :as response]
   [instant.model.instant-subscription :as instant-subscription-model]
   [instant.postmark :as postmark]
   [instant.discord :as discord]
   [instant.util.json :refer [<-json]]
   [ring.util.request :refer [body-string]]
   [instant.model.instant-user :as instant-user-model]
   [instant.util.tracer :as tracer]
   [instant.util.exception :as ex])
  (:import (com.stripe Stripe)
           (com.stripe.model Event)
           (com.stripe.net Webhook)))

(def FREE_SUBSCRIPTION_TYPE 1)
(def PRO_SUBSCRIPTION_TYPE 2)


(defn pro-plan? [{:keys [name]}]
  (= name "Pro"))

(defn ping-js-on-new-customer [user-id]
  (let [{email :email} (instant-user-model/get-by-id {:id user-id})
        message (str "🎉 New customer! " email)]
    (discord/send! config/discord-signups-channel-id message)
    (postmark/send!
     {:from "Instant Assistant <hello@pm.instantdb.com>"
      :to "founders@instantdb.com"
      :subject message
      :html
      (str
       "<div>
             <p>Hey hey! We just got a new paying customer!</p>
             <p>Email: " email "</p>
             <p>Woohoo! Send them a ping as a token of appreciation!</p>
           </div>")})))


(comment
  (def u (instant-user-model/get-by-email {:email "stopa@instantdb.com"}))
  (ping-js-on-new-customer (:id u)))

(defn ping-js-on-churned-customer [user-id]
  (let [{email :email} (instant-user-model/get-by-id {:id user-id})
        message (str "🪣  Churned customer! " email)]
    (discord/send! config/discord-signups-channel-id message)
    (postmark/send!
     {:from "Instant Assistant <hello@pm.instantdb.com>"
      :to "founders@instantdb.com"
      :subject message
      :html
      (str
       "<div>
             <p>Looks like one of our customers churned!</p>
             <p>Email: " email "</p>
             <p>Maybe we should send them a ping to learn why they churned?</p>
           </div>")})))

(comment
  (def u (instant-user-model/get-by-email {:email "stopa@instantdb.com"}))
  (ping-js-on-churned-customer (:id u)))

(defn- processed-event?
  [event-id]
  (instant-subscription-model/get-by-event-id {:event-id event-id}))

(defn handle-stripe-webhook-event
  [{:keys [id type data] :as _event}]
  (tracer/with-span! {:name "stripe-webhook/handle-event"
                      :attributes {:event-id id
                                   :event-type type}}
    (if (processed-event? id)
      (tracer/add-data! {:attributes {:already-processed? true}})
      (let [{customer-id :customer
             subscription-id :subscription
             {:keys [app-id user-id]} :metadata}
            (:object data)

            shared {:user-id user-id
                    :app-id app-id
                    :stripe-customer-id customer-id
                    :stripe-subscription-id subscription-id
                    :stripe-event-id id}]
        (condp = type
          "checkout.session.completed"
          (let [opts (assoc shared :subscription-type-id PRO_SUBSCRIPTION_TYPE)]
            (instant-subscription-model/create! opts)
            (when (= :prod (config/get-env))
              (ping-js-on-new-customer user-id))
            (tracer/add-data! {:attributes opts}))

          "customer.subscription.deleted"
          (let [opts (assoc shared :subscription-type-id FREE_SUBSCRIPTION_TYPE)]
            (instant-subscription-model/create! opts)
            (when (= :prod (config/get-env))
              (ping-js-on-churned-customer user-id))
            (tracer/add-data! {:attributes opts}))

          (tracer/add-data! {:attributes {:skipped-event? true}}))))))

(defn webhook
  [{:keys [headers] :as req}]
  (let [sig (get headers "stripe-signature")
        body-str (body-string req)
        ^Event event (Webhook/constructEvent
                      body-str
                      sig
                      (config/stripe-webhook-secret))]
    (when-not event
      (ex/throw-validation-err! :stripe-webhook-body
                                {:sig sig
                                 :body-str body-str}
                                [{:message "Could not construct event"}]))
    (let [clj-event (<-json body-str true)]
      (handle-stripe-webhook-event clj-event)
      (response/ok {:received true}))))

(defn init []
  (if-let [stripe-secret (config/stripe-secret)]
    (set! (. Stripe -apiKey) stripe-secret)
    (tracer/record-info!
     {:name "missing-stripe-secret"
      :attributes {:msg "There is no stripe-secret in config, Stripe will be disabled."}})))